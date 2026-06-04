import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'

import type { AgentTool } from '@mariozechner/pi-agent-core'
import {
  createBashTool as piCreateBashTool,
  defineTool as piDefineTool,
  editTool as piEditTool,
  findTool as piFindTool,
  grepTool as piGrepTool,
  lsTool as piLsTool,
  readTool as piReadTool,
  writeTool as piWriteTool,
} from '@mariozechner/pi-coding-agent'
import type { BashSpawnContext, ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { Static, TSchema } from '@sinclair/typebox'
import { Type } from '@sinclair/typebox'
import { z } from 'zod'

import {
  ACKNOWLEDGE_GUARDS,
  checkManagedConfigGuard,
  checkNonWorkspaceWriteGuard,
  checkSkillAuthoringGuard,
} from '@/bundled-plugins/guard/policy'
import type { PermissionService } from '@/permissions/permissions'
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
import {
  buildSandboxedCommand,
  ensureBwrapAvailable,
  resolveHiddenPaths,
  resolveProtectedZones,
  resolveWritableZones,
  subtractMasked,
} from '@/sandbox'

import { createLoopGuard, type LoopGuard } from './loop-guard'
import { checkImageReadRedirect } from './multimodal/read-redirect'
import type { SessionOrigin } from './session-origin'
import { webfetchTool } from './tools/webfetch'
import { websearchTool } from './tools/websearch'

// Process-wide loop guard. State is keyed by sessionId so concurrent sessions
// don't interfere; the guard's own LRU bound keeps it from growing without
// limit. Wrappers consult it before invoking the underlying tool so the
// detector covers every tool category — plugin tools, TypeClaw system tools,
// and pi-coding-agent builtins — through one chokepoint.
let sharedLoopGuard: LoopGuard = createLoopGuard()

// Internal, non-model-facing contract: a tool.before hook may set this key on
// a bash call's args to inject env vars into the spawned process WITHOUT
// putting them in the command string (where they would leak through logs and
// later hooks). The wrapper extracts and deletes it before the bash tool runs,
// then threads it to the spawn (non-sandboxed) and to bwrap --setenv
// (sandboxed). Used by github-cli-auth to inject a per-repo GH_TOKEN. The key
// is stripped from client-supplied args before tool.before so only trusted
// hooks can set it.
export const TYPECLAW_INTERNAL_BASH_ENV = '__typeclawBashEnv'

type BashEnvOverlay = Record<string, string>

const bashEnvStore = new AsyncLocalStorage<BashEnvOverlay | undefined>()

function readBashEnvOverlay(args: Record<string, unknown>): BashEnvOverlay | undefined {
  const raw = args[TYPECLAW_INTERNAL_BASH_ENV]
  if (raw === null || typeof raw !== 'object') return undefined
  const overlay: BashEnvOverlay = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') overlay[key] = value
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined
}

function bashSpawnHookWithOverlay(context: BashSpawnContext): BashSpawnContext {
  const overlay = bashEnvStore.getStore()
  if (overlay === undefined) return context
  return { ...context, env: { ...context.env, ...overlay } }
}

const piBashTool = piCreateBashTool(process.cwd(), { spawnHook: bashSpawnHookWithOverlay })

const ACKNOWLEDGE_GUARDS_SCHEMA = Type.Optional(
  Type.Object(
    {
      nonWorkspaceWrite: Type.Optional(Type.Boolean()),
      rolePromotion: Type.Optional(Type.Boolean()),
      cronPromotion: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
)

// pi-coding-agent 0.67.3 contract (load-bearing for hook coverage):
//   - `createAgentSession({ tools: AgentTool[] })` is ONLY a name filter for
//     `initialActiveToolNames`. It does NOT swap builtin implementations.
//   - `customTools: ToolDefinition[]` entries override builtins by name in
//     `_refreshToolRegistry` (the registry merge writes customTools last).
//
// Consequence: to put a `tool.before` hook around pi's builtin read/bash/edit/
// write, TypeClaw must wrap them as `ToolDefinition`s and pass them via
// `customTools` — not via `tools`. `wrapAgentToolAsCustomToolDefinition`
// produces those wrapped definitions; `setupSession` in `src/agent/index.ts`
// appends them whenever the session has any `tool.before` / `tool.after`
// hooks registered. Subagent narrowing still comes from `tools:` (the
// name-filter path); the wrapped customTools just replace the implementation
// underneath so subagent and channel sessions share the same hook coverage.
type PiAgentToolName = 'read' | 'bash' | 'edit' | 'write' | 'grep' | 'find' | 'ls'
type TypeclawToolName = 'websearch' | 'webfetch'

const PI_AGENT_TOOL_MAP: Record<PiAgentToolName, AgentTool<any, any>> = {
  read: piReadTool,
  bash: piBashTool,
  edit: piEditTool,
  write: piWriteTool,
  grep: piGrepTool,
  find: piFindTool,
  ls: piLsTool,
}

const TYPECLAW_TOOL_DEFINITION_MAP: Record<TypeclawToolName, ToolDefinition<any, any, any>> = {
  websearch: websearchTool,
  webfetch: webfetchTool,
}

function isPiAgentToolName(name: string): name is PiAgentToolName {
  return name in PI_AGENT_TOOL_MAP
}

function isTypeclawToolName(name: string): name is TypeclawToolName {
  return name in TYPECLAW_TOOL_DEFINITION_MAP
}

export type ResolvedBuiltinTools = {
  agentTools: AgentTool<any, any>[]
  toolDefinitions: ToolDefinition<any, any, any>[]
}

export function resolveBuiltinToolRefs(refs: BuiltinToolRef[]): ResolvedBuiltinTools {
  const agentTools: AgentTool<any, any>[] = []
  const toolDefinitions: ToolDefinition<any, any, any>[] = []
  for (const ref of refs) {
    const name = ref.__builtinTool
    if (isPiAgentToolName(name)) {
      agentTools.push(PI_AGENT_TOOL_MAP[name])
    } else if (isTypeclawToolName(name)) {
      toolDefinitions.push(TYPECLAW_TOOL_DEFINITION_MAP[name])
    } else {
      throw new Error(`unknown built-in tool ref: ${name}`)
    }
  }
  return { agentTools, toolDefinitions }
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
  // Resolves the current turn's abort handle. Resolved lazily (not at wrap
  // time) because tools are wrapped BEFORE `createAgentSession` returns the
  // session whose `agent.abort` this points at. See `fireLoopAbort`.
  getAbort?: () => (() => void) | undefined
}

export type WrapSystemToolOptions = {
  agentDir: string
  sessionId: string
  hooks: HookBus
  getOrigin?: () => SessionOrigin | undefined
  getAbort?: () => (() => void) | undefined
  // When present, the bash builtin is rewritten through the per-tool bwrap
  // sandbox with role-derived path masks. Absent (or no masks for the role)
  // runs bash unchanged — preserving today's behavior for trusted+ and for
  // sessions wired without a permission service (e.g. tests).
  permissions?: PermissionService
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

      const loopDecision = sharedLoopGuard.check(opts.sessionId, opts.toolName, before.args)
      if (loopDecision.kind === 'block') {
        fireLoopAbort(opts.getAbort)
        return errorResult(loopDecision.message)
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

      if (loopDecision.kind === 'warn') {
        result = appendLoopWarning(result, loopDecision.message)
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
      const loopDecision = sharedLoopGuard.check(opts.sessionId, tool.name, mutableArgs)
      if (loopDecision.kind === 'block') {
        fireLoopAbort(opts.getAbort)
        throw new Error(loopDecision.message)
      }
      const guardResult = await runFinalWriteGuards({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (guardResult !== undefined) {
        throw new Error(`blocked: ${guardResult.reason}`)
      }
      const readGuardResult = runFinalReadGuards({ tool: tool.name, args: mutableArgs })
      if (readGuardResult !== undefined) {
        throw new Error(`blocked: ${readGuardResult.reason}`)
      }
      stripGuardAcknowledgements(mutableArgs)

      const result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate, ctx)
      const hookResult: ToolResult = {
        content: result.content as ContentPart[],
        details: result.details,
      }
      if (loopDecision.kind === 'warn') {
        const warned = appendLoopWarning(hookResult, loopDecision.message)
        hookResult.content = warned.content
        hookResult.details = warned.details
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
      const loopDecision = sharedLoopGuard.check(opts.sessionId, tool.name, mutableArgs)
      if (loopDecision.kind === 'block') {
        fireLoopAbort(opts.getAbort)
        throw new Error(loopDecision.message)
      }
      const guardResult = await runFinalWriteGuards({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (guardResult !== undefined) {
        throw new Error(`blocked: ${guardResult.reason}`)
      }
      const readGuardResult = runFinalReadGuards({ tool: tool.name, args: mutableArgs })
      if (readGuardResult !== undefined) {
        throw new Error(`blocked: ${readGuardResult.reason}`)
      }
      stripGuardAcknowledgements(mutableArgs)

      const result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate)
      const hookResult: ToolResult = {
        content: result.content as ContentPart[],
        details: result.details,
      }
      if (loopDecision.kind === 'warn') {
        const warned = appendLoopWarning(hookResult, loopDecision.message)
        hookResult.content = warned.content
        hookResult.details = warned.details
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

// Wraps a pi-coding-agent AgentTool into a ToolDefinition so it can ride in
// `customTools` and override pi's same-named builtin (see top-of-file contract
// block). The hook + guard pipeline matches `wrapSystemAgentTool`; only the
// input/output shape differs.
export function wrapAgentToolAsCustomToolDefinition<TParams extends TSchema, TDetails = unknown>(
  tool: AgentTool<TParams, TDetails>,
  opts: WrapSystemToolOptions,
): ToolDefinition<TParams, TDetails> {
  return piDefineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters),
    prepareArguments: tool.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate) {
      const mutableArgs = params as Record<string, unknown>
      const liveOrigin = opts.getOrigin?.()
      // Defense-in-depth: strip any pre-existing internal env-overlay key
      // before hooks run so only trusted tool.before hooks can set it.
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_ENV]
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
      // Extract and delete before the loop guard serializes args and before
      // the bash tool destructures them, so the overlay never reaches logs,
      // loop-detection state, or pi's execute.
      const bashEnvOverlay = readBashEnvOverlay(mutableArgs)
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_ENV]
      const loopDecision = sharedLoopGuard.check(opts.sessionId, tool.name, mutableArgs)
      if (loopDecision.kind === 'block') {
        fireLoopAbort(opts.getAbort)
        throw new Error(loopDecision.message)
      }
      const guardResult = await runFinalWriteGuards({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (guardResult !== undefined) {
        throw new Error(`blocked: ${guardResult.reason}`)
      }
      const readGuardResult = runFinalReadGuards({ tool: tool.name, args: mutableArgs })
      if (readGuardResult !== undefined) {
        throw new Error(`blocked: ${readGuardResult.reason}`)
      }
      stripGuardAcknowledgements(mutableArgs)

      if (tool.name === 'bash' && opts.permissions !== undefined) {
        await applyBashSandbox(mutableArgs, opts.permissions, liveOrigin, opts.agentDir, bashEnvOverlay)
      }

      const result = await bashEnvStore.run(bashEnvOverlay, () =>
        tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate),
      )
      const hookResult: ToolResult = {
        content: result.content as ContentPart[],
        details: result.details,
      }
      if (loopDecision.kind === 'warn') {
        const warned = appendLoopWarning(hookResult, loopDecision.message)
        hookResult.content = warned.content
        hookResult.details = warned.details
      }
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      return {
        content: hookResult.content as ContentPart[],
        details: hookResult.details as TDetails,
      }
    },
  })
}

export function defaultBuiltinPiAgentTools(): AgentTool<any, any>[] {
  return [piReadTool, piBashTool, piEditTool, piWriteTool, piGrepTool, piFindTool, piLsTool]
}

export function buildBuiltinPiToolOverrides(opts: WrapSystemToolOptions): ToolDefinition<any, any>[] {
  return defaultBuiltinPiAgentTools().map((tool) => wrapAgentToolAsCustomToolDefinition(tool, opts))
}

// Rewrites mutableArgs.command in place so the bash builtin runs inside bwrap
// with role-derived path masks. A role that sees everything (trusted+) yields
// no masks and runs unchanged. When masks ARE needed but bwrap is unavailable
// we throw rather than run unsandboxed — fail closed, never leak the masked
// surface. Runs after the tool.before guards have inspected the raw command.
async function applyBashSandbox(
  mutableArgs: Record<string, unknown>,
  permissions: PermissionService,
  origin: SessionOrigin | undefined,
  agentDir: string,
  envOverlay: BashEnvOverlay | undefined,
): Promise<void> {
  const command = mutableArgs.command
  if (typeof command !== 'string') return

  const { dirs, files } = resolveHiddenPaths(permissions, origin, agentDir)
  if (dirs.length === 0 && files.length === 0) return

  await ensureBwrapAvailable()
  // Write-confined jail for low-trust roles: bind the whole project read-only,
  // hide private/secret paths, then re-expose only the free-write scratch zones
  // (workspace + root allowlist + .git) RW. The WORKING TREE outside those zones
  // (node_modules/, agentDir root, non-allowlisted tracked files) stays EROFS, so
  // bash cannot sidestep the non-workspace-write guard — and `git checkout` of a
  // protected worktree path fails at the kernel. .git is RW so members can
  // commit; .git/hooks + .git/config are re-protected RO (protected, rendered
  // after writable) so a hook-plant / core.hooksPath does not become code
  // execution in the unsandboxed runtime git ops. Trusted/owner never reach here
  // (their masks are empty) and keep full unsandboxed access. subtractMasked
  // drops any writable zone masked for this role so an RW bind never re-exposes a
  // hidden path (e.g. a guest's masked workspace/).
  const writable = subtractMasked(await resolveWritableZones(agentDir), { dirs, files })
  const protectedZones = writable.dirs.includes(join(agentDir, '.git'))
    ? await resolveProtectedZones(agentDir)
    : { dirs: [], files: [] }
  // bwrap does --clearenv, so the overlay must be re-introduced via env.set or
  // it would never reach the sandboxed process (the non-sandboxed spawnHook
  // path does not run when the command is rewritten to a bwrap invocation).
  const { commandString } = buildSandboxedCommand(command, {
    mounts: [{ type: 'ro-bind', source: agentDir, dest: agentDir }],
    masks: { dirs, files },
    writable,
    protected: protectedZones,
    network: 'inherit',
    cwd: agentDir,
    ...(envOverlay !== undefined ? { env: { set: envOverlay } } : {}),
  })
  mutableArgs.command = commandString
}

function appendLoopWarning(result: ToolResult, message: string): ToolResult {
  const content: ContentPart[] = [...(result.content as ContentPart[]), { type: 'text', text: message }]
  return { content, details: result.details }
}

// Test-only seam: swaps the shared loop guard for a fresh instance so tests
// that reuse sessionIds across cases don't see cross-test streak counts.
// Production code never calls this; the guard's LRU bound handles
// long-running processes.
export function __resetSharedLoopGuardForTests(): void {
  sharedLoopGuard = createLoopGuard()
}

// A loop-guard `block` verdict returned/thrown from a tool's execute() is
// caught by pi-agent-core and surfaced to the model as an `isError` result,
// which the model simply retries — the loop never ends. Aborting the run's
// AbortSignal is the only thing that actually stops the in-flight turn (the
// next assistant stream sees the aborted signal and ends with stopReason
// 'aborted'). We use the signal-only `agent.abort`, never `session.abort`,
// which would deadlock awaiting the very run this tool call belongs to. See
// the matching pattern in src/channels/router.ts (policy-denied send cap).
function fireLoopAbort(getAbort: (() => (() => void) | undefined) | undefined): void {
  getAbort?.()?.()
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { error: true, message },
    isError: true,
  }
}

async function runFinalWriteGuards(options: { tool: string; args: Record<string, unknown>; agentDir: string }) {
  return (
    (await checkManagedConfigGuard(options)) ??
    (await checkSkillAuthoringGuard(options)) ??
    checkNonWorkspaceWriteGuard(options)
  )
}

function runFinalReadGuards(options: { tool: string; args: Record<string, unknown> }) {
  return checkImageReadRedirect(options)
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
