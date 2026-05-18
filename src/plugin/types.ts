import type { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import type { ToolResultBudget } from '@/agent/tool-result-budget'
import type { PermissionService } from '@/permissions'

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

export type ToolResult = {
  content: ContentPart[]
  details?: unknown
}

export type ToolLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type ToolContext = {
  signal: AbortSignal | undefined
  sessionId: string
  agentDir: string
  logger: ToolLogger
}

export type Tool<P = unknown> = {
  description: string
  parameters: z.ZodType<P>
  execute: (args: P, ctx: ToolContext) => Promise<ToolResult>
}

export type BuiltinToolRef = { readonly __builtinTool: string }

export type SubagentContext<P = unknown> = {
  userPrompt: string
  agentDir: string
  payload: P
}

export type RunSession = (override?: { userPrompt?: string }) => Promise<void>

export type Subagent<P = unknown> = {
  systemPrompt: string
  // Model profile this subagent prefers. Resolved against `models` in
  // typeclaw.json at session construction. Unknown profile names fall back to
  // `default` with a warning. Well-known names: `default`, `fast`, `deep`,
  // `vision`. Subagents that want a specific tier (e.g. memory-logger wants
  // `fast`, dreaming wants `deep`) declare it here so the user only has to
  // map tier → model in config rather than wire each subagent individually.
  profile?: string
  tools?: BuiltinToolRef[]
  customTools?: Tool<any>[]
  payloadSchema?: z.ZodType<P>
  handler?: (ctx: SubagentContext<P>, runSession: RunSession) => Promise<void>
  // Coalescing key for the SubagentConsumer's in-flight set. Default is the
  // subagent name alone (only one instance of the subagent runs at a time).
  // Override to allow per-payload concurrency, e.g. memory-logger keyed by
  // parentSessionId so different parent sessions run in parallel while
  // duplicate runs against the same session deduplicate.
  inFlightKey?: (payload: P) => string
  // Defensive ceiling on cumulative bytes of tool-result text per subagent
  // run, applied to the named tools only. Once exceeded, subsequent calls to
  // those tools short-circuit with a fixed message instructing the agent to
  // stop reading. See `src/agent/tool-result-budget.ts` for the full
  // rationale; the short version is: a single broken tool (e.g. find_entry
  // failing because of a schema mismatch) can cause an agent to fall back to
  // chunked reads of huge files, ballooning subagent token cost. The budget
  // bounds the blast radius without changing per-call semantics for healthy
  // runs.
  toolResultBudget?: ToolResultBudget
}

// Cron job map keys are local; the runtime prefixes with `__plugin_<plugin-name>_`
// to form the global cron id, guaranteeing no collision with cron.json user
// jobs (no underscore prefix) or across plugins.
export type PluginPromptCronJob = {
  schedule: string
  kind: 'prompt'
  prompt: string
  enabled?: boolean
  timezone?: string
  subagent?: string
  payload?: unknown
}

export type PluginExecCronJob = {
  schedule: string
  kind: 'exec'
  command: string[]
  enabled?: boolean
  timezone?: string
}

export type PluginCronJob = PluginPromptCronJob | PluginExecCronJob

export type PluginSkill = {
  description: string
  content: string
  frontmatter?: Record<string, unknown>
}

export type SessionStartEvent = {
  sessionId: string
  agentDir: string
}

export type SessionEndEvent = {
  sessionId: string
  origin?: SessionOrigin
}

export type SessionIdleEvent = {
  sessionId: string
  parentTranscriptPath: string | undefined
  idleMs: number
  origin?: SessionOrigin
}

// Brackets every `session.prompt(...)` invocation. Distinct from
// `session.start`/`session.end` (which bracket session lifetime) so that
// long-lived TUI or channel sessions, which can sit idle between turns,
// don't wedge a turn-counter forever. `origin` carries the session's origin
// so observers can exclude their own induced turns when counting (e.g. the
// backup plugin excludes `subagent: 'backup'` to avoid self-gating).
export type SessionTurnStartEvent = {
  sessionId: string
  agentDir: string
  origin?: SessionOrigin
}

export type SessionTurnEndEvent = {
  sessionId: string
  agentDir: string
  origin?: SessionOrigin
}

// Provider prompt caching requires byte-identical prefixes. Mutations near the
// end of `event.prompt` preserve cache hits across sessions; mutations near
// the start invalidate the cache on every LLM call.
export type SessionPromptEvent = {
  prompt: string
  sessionId: string
  agentDir: string
  origin?: SessionOrigin
}

// Fired for plugin-defined tools and TypeClaw-exposed system tools, including
// built-in pi tools (read/bash/edit/write/grep/find/ls) when plugins are wired.
export type ToolBeforeEvent = {
  tool: string
  sessionId: string
  callId: string
  args: Record<string, unknown>
  origin?: SessionOrigin
}

export type ToolBeforeResult = void | undefined | { block: true; reason: string }

export type ToolAfterEvent = {
  tool: string
  sessionId: string
  callId: string
  result: ToolResult
}

export type HookContext = {
  agentDir: string
  pluginName: string
  logger: PluginLogger
}

export type Hooks = {
  'session.start'?: (event: SessionStartEvent, ctx: HookContext) => Promise<void> | void
  'session.end'?: (event: SessionEndEvent, ctx: HookContext) => Promise<void> | void
  'session.idle'?: (event: SessionIdleEvent, ctx: HookContext) => Promise<void> | void
  'session.prompt'?: (event: SessionPromptEvent, ctx: HookContext) => Promise<void> | void
  'session.turn.start'?: (event: SessionTurnStartEvent, ctx: HookContext) => Promise<void> | void
  'session.turn.end'?: (event: SessionTurnEndEvent, ctx: HookContext) => Promise<void> | void
  'tool.before'?: (event: ToolBeforeEvent, ctx: HookContext) => Promise<ToolBeforeResult> | ToolBeforeResult
  'tool.after'?: (event: ToolAfterEvent, ctx: HookContext) => Promise<void> | void
}

export type HookName = keyof Hooks

export type PluginLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type SpawnSubagentOptions = {
  // Identifies the spawning session so the subagent's session origin carries
  // parent provenance. Hook handlers that own this context (e.g. session.idle,
  // session.turn.end) should pass at minimum `parentSessionId` and
  // `spawnedByOrigin: event.origin`. The runtime resolves `spawnedByRole`
  // from the origin via the PermissionService, so the spawning session's
  // role is inherited rather than forged from outside.
  parentSessionId?: string
  spawnedByOrigin?: SessionOrigin
}

export type PluginContext<TConfig = never> = {
  readonly name: string
  readonly version: string | undefined
  readonly agentDir: string
  readonly config: TConfig
  readonly logger: PluginLogger
  readonly permissions: PermissionService
  spawnSubagent: (name: string, payload?: unknown, options?: SpawnSubagentOptions) => Promise<void>
}

export type PluginExports = {
  tools?: Record<string, Tool<any>>
  subagents?: Record<string, Subagent<any>>
  cronJobs?: Record<string, PluginCronJob>
  skills?: Record<string, PluginSkill>
  skillsDirs?: string[]
  hooks?: Hooks
  doctorChecks?: Record<string, PluginDoctorCheck>
}

// `typeclaw doctor` plugin extension surface. Each check is read-only by
// default; declaring `fix.apply` opts the check into `typeclaw doctor --fix`,
// where the host serializes plugin fixes, validates their `changedPaths`
// against the agent folder, and commits the union of all fixes in a single
// commit.
export type PluginDoctorCheck = {
  description: string
  category?: string
  run: (ctx: PluginDoctorContext) => Promise<PluginCheckResult>
}

export type PluginDoctorContext = {
  readonly pluginName: string
  readonly agentDir: string
  readonly config: unknown
  readonly logger: PluginLogger
}

export type PluginCheckStatus = 'ok' | 'warning' | 'error'

export type PluginCheckResult = {
  status: PluginCheckStatus
  message: string
  details?: string[]
  fix?: PluginFixSuggestion
}

export type PluginFixSuggestion = {
  description: string
  // When omitted, the fix is advisory-only. `typeclaw doctor --fix` only
  // attempts to remediate checks whose suggestion includes an `apply`.
  apply?: (ctx: PluginDoctorContext) => Promise<PluginFixResult>
}

export type PluginFixResult = {
  // One-line description that appears in the commit body as a bullet.
  summary: string
  // POSIX paths relative to agentDir; the host validates each one stays
  // inside agentDir before `git add`ing. Absolute paths and `..` segments
  // are rejected to keep plugin fixes from staging files outside the agent
  // folder. Empty array is valid (e.g. a fix that only logs).
  changedPaths: string[]
}

export type DefinedPlugin<TConfig = never> = {
  readonly configSchema?: z.ZodType<TConfig>
  readonly permissions?: readonly string[]
  // Declared by-value (not built inside the factory) so the host-stage CLI
  // can dispatch commands without booting plugin runtime state.
  readonly commands?: Record<string, PluginCommand>
  readonly plugin: (ctx: PluginContext<TConfig>) => Promise<PluginExports>
}

// `surface` controls where a plugin command may run: `'container'` requires
// the agent runtime (prompt/subagent/exec); `'host'` runs on the user's
// machine with no agent runtime; `'either'` accepts the intersection ctx
// and runs on whichever stage the user invoked it from.
export type PluginCommand = ContainerCommand | HostCommand | EitherCommand

export type ContainerCommand<A = unknown> = {
  readonly surface: 'container'
  readonly description: string
  // v1 constraint: `z.object({...})` with primitive (string/number/boolean/
  // literal/enum) leaves so `--help` can render `--<name>=<type>`.
  readonly args?: z.ZodObject<z.ZodRawShape>
  readonly permissions?: readonly string[]
  // When true, runtime spawns a fresh Bun subprocess instead of dispatching
  // in-process. Costs ~150ms cold-start; trade for isolation from the agent.
  readonly isolated?: boolean
  readonly run: (ctx: ContainerCommandContext, args: A) => Promise<number>
}

export type HostCommand<A = unknown> = {
  readonly surface: 'host'
  readonly description: string
  readonly args?: z.ZodObject<z.ZodRawShape>
  readonly run: (ctx: HostCommandContext, args: A) => Promise<number>
}

export type EitherCommand<A = unknown> = {
  readonly surface: 'either'
  readonly description: string
  readonly args?: z.ZodObject<z.ZodRawShape>
  readonly run: (ctx: EitherCommandContext, args: A) => Promise<number>
}

export type CommandStreams = {
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: WritableStream<Uint8Array>
  readonly stderr: WritableStream<Uint8Array>
}

export type CommandExecResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type ContainerCommandContext = CommandStreams & {
  // The plugin name (e.g. `'my-utilities'`), NOT the command name. Matches
  // `PluginContext.name`. Use the command's own static name if you need it.
  readonly name: string
  readonly version: string | undefined
  readonly agentDir: string
  readonly logger: PluginLogger
  readonly permissions: PermissionService
  // Caller's origin (cron job, TUI op, parent session). Drives permission
  // resolution inside the command. Dispatcher refuses to run without one.
  readonly origin: SessionOrigin
  readonly signal: AbortSignal
  readonly prompt: (text: string) => Promise<string>
  readonly subagent: (name: string, payload?: unknown) => Promise<void>
  readonly exec: (cmd: TemplateStringsArray, ...values: unknown[]) => Promise<CommandExecResult>
}

export type HostCommandContext = CommandStreams & {
  // The plugin name, NOT the command name. See `ContainerCommandContext.name`.
  readonly name: string
  readonly version: string | undefined
  // Host path of the agent folder (e.g. the absolute path to the agent
  // folder), NOT `/agent`.
  readonly agentDir: string
  readonly logger: PluginLogger
  readonly signal: AbortSignal
}

export type EitherCommandContext = CommandStreams & {
  // The plugin name, NOT the command name. See `ContainerCommandContext.name`.
  readonly name: string
  readonly version: string | undefined
  // Resolves to `/agent` in container, host path on host — same author code.
  readonly agentDir: string
  readonly logger: PluginLogger
  readonly signal: AbortSignal
}
