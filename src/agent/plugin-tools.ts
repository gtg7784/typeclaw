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
import { z } from 'zod'

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

type AnyAgentTool =
  | typeof piReadTool
  | typeof piBashTool
  | typeof piEditTool
  | typeof piWriteTool
  | typeof piGrepTool
  | typeof piFindTool
  | typeof piLsTool

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
}

export type WrapSystemToolOptions = {
  agentDir: string
  sessionId: string
  hooks: HookBus
}

export function zodToToolParameters(schema: z.ZodType<unknown>): TSchema {
  const json = z.toJSONSchema(schema, { io: 'input', reused: 'inline' })
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
      const before: ToolBeforeEvent = {
        tool: opts.toolName,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mutableArgs = params as Record<string, unknown>
      const blockResult = await opts.hooks.runToolBefore({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
      })
      if (blockResult !== undefined) {
        throw new Error(`blocked: ${blockResult.reason}`)
      }

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
    async execute(toolCallId, params, signal, onUpdate) {
      const mutableArgs = params as Record<string, unknown>
      const blockResult = await opts.hooks.runToolBefore({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
      })
      if (blockResult !== undefined) {
        throw new Error(`blocked: ${blockResult.reason}`)
      }

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
