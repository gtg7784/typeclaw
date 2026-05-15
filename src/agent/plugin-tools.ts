import type { AgentTool } from '@mariozechner/pi-agent-core'
import {
  bashTool as piBashTool,
  defineTool as piDefineTool,
  editTool as piEditTool,
  findTool as piFindTool,
  grepTool as piGrepTool,
  lsTool as piLsTool,
  readTool as piReadTool,
  writeTool as piWriteTool,
} from '@mariozechner/pi-coding-agent'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { Static, TSchema } from '@sinclair/typebox'
import { Type } from '@sinclair/typebox'
import { z } from 'zod'

import {
  ACKNOWLEDGE_GUARDS,
  checkNonWorkspaceWriteGuard,
  checkSkillAuthoringGuard,
} from '@/bundled-plugins/guard/policy'
import type {
  BuiltinToolRef,
  ContentPart,
  HookBus,
  PluginLogger,
  Tool,
  ToolBeforeEvent,
  ToolContext,
  ToolResult,
} from '@/plugin'

import type { SessionOrigin } from './session-origin'

type AnyAgentTool =
  | typeof piReadTool
  | typeof piBashTool
  | typeof piEditTool
  | typeof piWriteTool
  | typeof piGrepTool
  | typeof piFindTool
  | typeof piLsTool

const ACKNOWLEDGE_GUARDS_SCHEMA = Type.Optional(
  Type.Object(
    {
      nonWorkspaceWrite: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
)

const BUILTIN_TOOL_MAP: Record<string, AnyAgentTool> = {
  bash: piBashTool,
  edit: piEditTool,
  find: piFindTool,
  grep: piGrepTool,
  ls: piLsTool,
  read: piReadTool,
  write: piWriteTool,
}

export function resolveBuiltinToolRefs(refs: BuiltinToolRef[]): AnyAgentTool[] {
  return refs.map((ref) => {
    const tool = BUILTIN_TOOL_MAP[ref.__builtinTool]
    if (!tool) throw new Error(`unknown built-in tool ref: ${ref.__builtinTool}`)
    return tool
  })
}

export type WrapToolOptions = {
  pluginName: string
  toolName: string
  agentDir: string
  sessionId: string
  logger: PluginLogger
  hooks: HookBus
  // Called at tool-execute time (not at wrap time) so channel sessions whose
  // origin mutates per turn surface the current-turn `lastInboundAuthorId`
  // to `tool.before`. Sessions with a fixed origin can pass `() => origin`.
  getOrigin?: () => SessionOrigin | undefined
}

export type WrapSystemToolOptions = {
  agentDir: string
  sessionId: string
  hooks: HookBus
  getOrigin?: () => SessionOrigin | undefined
}

// Zod 4 emits a top-level `"$schema": "https://json-schema.org/draft/2020-12/schema"`
// pointer on every converted schema. Ajv v8 (used by pi-ai's runtime tool-argument
// validator and by ModelRegistry's models.json validator) is configured for
// Draft 7 and rejects unknown `$schema` URIs with:
//
//   no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
//
// That error is raised before the tool's execute is even invoked, so the model
// sees the failure as a tool-call result and reacts by retrying or falling back
// to other tools. In the memory-logger / dreaming subagents this meant the
// `find_entry` tool was permanently broken: the subagent kept falling back to
// `read(offset=1, limit=2000)` and chunked through entire multi-hundred-KB
// transcripts on every channel turn. Stripping `$schema` is the minimal,
// converter-version-independent fix; it leaves the actual JSON-schema body
// untouched and lets Ajv use its default draft.
export function zodToToolParameters(schema: z.ZodType<unknown>): TSchema {
  const json = z.toJSONSchema(schema, { io: 'input', reused: 'inline' }) as Record<string, unknown>
  delete json.$schema
  return json as unknown as TSchema
}

export function wrapPluginTool(tool: Tool<any>, opts: WrapToolOptions): ToolDefinition {
  const parameters = zodToToolParameters(tool.parameters)

  return piDefineTool({
    name: opts.toolName,
    label: opts.toolName,
    description: tool.description,
    parameters,
    async execute(toolCallId, params, signal) {
      const validated = tool.parameters.safeParse(params)
      if (!validated.success) {
        return errorResult(`invalid arguments: ${validated.error.message}`)
      }

      const mutableArgs = validated.data as Record<string, unknown>
      const liveOrigin = opts.getOrigin?.()
      const before: ToolBeforeEvent = {
        tool: opts.toolName,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
        ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
      }
      const blockResult = await opts.hooks.runToolBefore(before)
      if (blockResult !== undefined) {
        return errorResult(`blocked: ${blockResult.reason}`)
      }

      const toolCtx: ToolContext = {
        signal,
        sessionId: opts.sessionId,
        agentDir: opts.agentDir,
        logger: opts.logger,
      }

      let result: ToolResult
      try {
        result = await tool.execute(before.args, toolCtx)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(message)
      }

      await opts.hooks.runToolAfter({
        tool: opts.toolName,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result,
      })

      return {
        content: result.content as ContentPart[],
        details: result.details,
      }
    },
  })
}

export function wrapSystemTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  opts: WrapSystemToolOptions,
): ToolDefinition<TParams, TDetails, TState> {
  return piDefineTool({
    ...tool,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mutableArgs = params as Record<string, unknown>
      const liveOrigin = opts.getOrigin?.()
      const blockResult = await opts.hooks.runToolBefore({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
        ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
      })
      if (blockResult !== undefined) {
        throw new Error(`blocked: ${blockResult.reason}`)
      }
      const guardResult = await runFinalWriteGuards({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (guardResult !== undefined) {
        throw new Error(`blocked: ${guardResult.reason}`)
      }
      stripGuardAcknowledgements(mutableArgs)

      const result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate, ctx)
      const hookResult: ToolResult = {
        content: result.content as ContentPart[],
        details: result.details,
      }
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      return {
        content: hookResult.content,
        details: hookResult.details as TDetails,
      }
    },
  })
}

export function wrapSystemAgentTool<TParams extends TSchema, TDetails = unknown>(
  tool: AgentTool<TParams, TDetails>,
  opts: WrapSystemToolOptions,
): AgentTool<TParams, TDetails> {
  return {
    ...tool,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters),
    async execute(toolCallId, params, signal, onUpdate) {
      const mutableArgs = params as Record<string, unknown>
      const liveOrigin = opts.getOrigin?.()
      const blockResult = await opts.hooks.runToolBefore({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
        ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
      })
      if (blockResult !== undefined) {
        throw new Error(`blocked: ${blockResult.reason}`)
      }
      const guardResult = await runFinalWriteGuards({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (guardResult !== undefined) {
        throw new Error(`blocked: ${guardResult.reason}`)
      }
      stripGuardAcknowledgements(mutableArgs)

      const result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate)
      const hookResult: ToolResult = {
        content: result.content as ContentPart[],
        details: result.details,
      }
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      return {
        content: hookResult.content,
        details: hookResult.details as TDetails,
      }
    },
  }
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { error: true, message },
    isError: true,
  }
}

async function runFinalWriteGuards(options: { tool: string; args: Record<string, unknown>; agentDir: string }) {
  return (await checkSkillAuthoringGuard(options)) ?? checkNonWorkspaceWriteGuard(options)
}

function withGuardAcknowledgements<TParams extends TSchema>(toolName: string, parameters: TParams): TParams {
  if (toolName !== 'write' && toolName !== 'edit') return parameters

  const schema = parameters as Record<string, unknown>
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return parameters

  return {
    ...schema,
    properties: {
      ...(properties as Record<string, unknown>),
      [ACKNOWLEDGE_GUARDS]: ACKNOWLEDGE_GUARDS_SCHEMA,
    },
  } as unknown as TParams
}

function stripGuardAcknowledgements(args: Record<string, unknown>): void {
  delete args[ACKNOWLEDGE_GUARDS]
}
