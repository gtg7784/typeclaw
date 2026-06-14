import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { z } from 'zod'

import type { HookBus } from '@/plugin'
import type { Stream, Unsubscribe } from '@/stream'

import { type AgentSession, createSession, type PluginSessionWiring } from './index'
import { subscribeProviderErrors } from './provider-error'
import type { SubagentBashPolicy } from './reviewer-bash-policy'
import type { SessionOrigin } from './session-origin'
import {
  beginSubagentDrainWatch,
  runSubagentDrain,
  type SubagentBackgroundDrain,
  type SubagentDrainWatch,
} from './subagent-drain'
import { renderTurnTimeAnchor } from './system-prompt'
import type { ToolResultBudget } from './tool-result-budget'

type AgentSessionTools = NonNullable<Parameters<typeof createSession>[0]>['tools']

export type SubagentContext<P = unknown> = {
  userPrompt: string
  agentDir: string
  payload: P
}

export type RunSession = (override?: { userPrompt?: string }) => Promise<void>

// Fields shared verbatim between the plugin-author-facing `Subagent` in
// `@/plugin/types` and the runtime-internal `Subagent` below. Every consumer
// that reads from `SubagentRegistry` (the spawn_subagent tool, payload
// validation, default session construction) only touches these fields, so
// keeping them in a single declaration makes the plugin→internal shim a
// rest-spread instead of a hand-maintained property list. Adding a new field
// here surfaces it on both types in one edit, which is the regression class
// the previous shim shape suffered: `visibility` and `requiresSpecificPermission`
// existed on the plugin type but were silently dropped by the shim, so every
// plugin-contributed public subagent appeared internal at the registry layer.
//
// The two fields that intentionally diverge — `tools` and `customTools` —
// live on each concrete `Subagent` type below. The plugin side uses
// `BuiltinToolRef[]` + `Tool<any>[]` (the public plugin API, decoupled from
// pi-coding-agent's internal tool shape); the internal side uses the resolved
// `AgentSessionTools` + `ToolDefinition[]` that pi-coding-agent actually
// consumes. The boundary is real and load-bearing — collapsing it would
// expose pi-coding-agent's internal API as part of the plugin contract.
export type SubagentShared<P = unknown> = {
  systemPrompt: string
  // Model profile this subagent prefers. Resolved against `config.models` at
  // session construction. Unknown profile names fall back to `default` with
  // a warning. See `Subagent` in `@/plugin/types` for the full contract.
  profile?: string
  payloadSchema?: z.ZodType<P>
  handler?: (ctx: SubagentContext<P>, runSession: RunSession) => Promise<void>
  toolResultBudget?: ToolResultBudget
  visibility?: 'public' | 'internal'
  // One-line purpose blurb for the main agent's "## Subagent orchestration"
  // roster, rendered from the registry by `renderPublicSubagentRoster` instead
  // of hand-maintained in the prompt (the drift that once left `researcher` and
  // `planner` unlisted). Required for `visibility: 'public'`; ignored otherwise.
  // On `SubagentShared` so the plugin→internal shim carries it via rest-spread
  // (see `pluginSubagentShim`), like `visibility`.
  rosterDescription?: string
  requiresSpecificPermission?: boolean
  // Opt-in: when true, this subagent's session is wired with the orchestration
  // tools (spawn_subagent/subagent_output/subagent_cancel) so it can delegate
  // to its own subagents, bounded by MAX_SUBAGENT_DEPTH and caller-owned
  // registry scoping. Default (unset/false) keeps the subagent a leaf — the
  // historical contract for explorer/scout/memory-logger/etc.
  canSpawnSubagents?: boolean
  // Opt-in: allow this subagent to spawn background children AND drain their
  // completions back into its own session (requires canSpawnSubagents). Default
  // (unset/false) keeps background spawns denied from this subagent — it must
  // use synchronous spawns. Only meaningful when the runtime wires the drain
  // capability (createSessionForSubagent provides stream+sessionId+liveRegistry).
  canBackgroundSpawnSubagents?: boolean
  // Wall-clock ceiling on a single spawn, enforced at the orchestration
  // layer (both `dispatchSpawnSubagent` and the stream-driven
  // `SubagentConsumer`). When exceeded, the orchestrator's `await` settles
  // with a timeout error and releases the coalescing key for `inFlightKey`,
  // so the next spawn of the same (name, inFlightKey) can proceed instead
  // of being skip-coalesced. The underlying `invokeSubagent` call may keep
  // running — pi-coding-agent's `session.prompt` does not accept an
  // AbortSignal today, so a half-open LLM stream stays alive until the OS
  // reaps it. The trade-off is honest: cancellation is upstream's job;
  // releasing the coalescing key is ours, and that is what unblocks the
  // user-visible "every subsequent turn skipped while the first spawn
  // hangs" symptom. Omit for no ceiling (legacy behavior; the spawn waits
  // as long as the provider takes).
  timeoutMs?: number
  // Per-subagent bash capability restriction, enforced at the bash-wrap site
  // INDEPENDENT of the caller's role (unlike the role-derived bwrap sandbox,
  // which returns early for trusted/owner). A read-only subagent declares this
  // to fence its `bash` to read-only commands even when spawned by a privileged
  // caller. See `src/agent/reviewer-bash-policy.ts`. Omit for no restriction
  // (the historical contract — prompt-only enforcement).
  bashPolicy?: SubagentBashPolicy
}

export type Subagent<P = unknown> = SubagentShared<P> & {
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
}

export type SubagentRegistry = Readonly<Record<string, Subagent<any>>>

// Validate payload against the subagent's schema. Strict: when no schema is
// declared, a non-undefined payload is rejected to prevent silent drops of
// caller intent.
export function validateSubagentPayload(name: string, subagent: Subagent<any>, payload: unknown): unknown {
  if (subagent.payloadSchema) {
    const result = subagent.payloadSchema.safeParse(payload)
    if (!result.success) {
      throw new Error(`subagent ${name}: invalid payload: ${result.error.message}`)
    }
    return result.data
  }
  if (payload !== undefined) {
    throw new Error(`subagent ${name}: does not accept a payload (received ${describePayload(payload)})`)
  }
  return payload
}

function describePayload(payload: unknown): string {
  if (payload === null) return 'null'
  if (Array.isArray(payload)) return 'array'
  return typeof payload
}

export type CreateSessionForSubagentResult = {
  session: AgentSession
  dispose?: () => Promise<void>
  hooks?: HookBus
  sessionId?: string
  agentDir?: string
  origin?: SessionOrigin
  getTranscriptPath?: () => string | undefined
  backgroundDrain?: SubagentBackgroundDrain
}
export type CreateSessionForSubagentOptions = {
  name?: string
  parentSessionId?: string
  spawnedByRole?: string
  spawnedByOrigin?: SessionOrigin
  // Plugin hook wiring for the subagent's tools. When present, the subagent's
  // builtin bash/read/edit/write run through the plugin `tool.before`/`tool.after`
  // hooks (security guards AND github-cli-auth GitHub-token injection) exactly
  // like the main and plugin-subagent sessions. Without it, the builtin tools run
  // raw (the prior behavior) — so standalone/test callers stay unaffected. The
  // production runtime always supplies it (src/run/index.ts) so a generic
  // task-spawned subagent's `git push`/`gh` gets a minted token instead of
  // failing with "could not read Username".
  plugins?: PluginSessionWiring
}
export type CreateSessionForSubagent = (
  subagent: Subagent<any>,
  options?: CreateSessionForSubagentOptions,
) => Promise<AgentSession | CreateSessionForSubagentResult>

export const defaultCreateSessionForSubagent: CreateSessionForSubagent = (subagent, options) =>
  createSession({
    systemPromptOverride: subagent.systemPrompt,
    origin: {
      kind: 'subagent',
      subagent: options?.name ?? '<unknown>',
      parentSessionId: options?.parentSessionId ?? '<unknown>',
      ...(options?.spawnedByRole !== undefined ? { spawnedByRole: options.spawnedByRole } : {}),
      ...(options?.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
    },
    ...(subagent.tools ? { tools: subagent.tools } : {}),
    customTools: subagent.customTools ?? [],
    ...(options?.plugins !== undefined ? { plugins: options.plugins } : {}),
    ...(subagent.profile !== undefined ? { profile: subagent.profile } : {}),
    ...(subagent.toolResultBudget !== undefined ? { toolResultBudget: subagent.toolResultBudget } : {}),
    ...(subagent.bashPolicy !== undefined ? { bashPolicy: subagent.bashPolicy } : {}),
  })

type NormalizedSubagentSession = {
  session: AgentSession
  dispose: () => Promise<void>
  hooks: HookBus | undefined
  sessionId: string | undefined
  agentDir: string | undefined
  origin: SessionOrigin | undefined
  getTranscriptPath: (() => string | undefined) | undefined
  backgroundDrain: SubagentBackgroundDrain | undefined
}

function normalizeSubagentSession(result: AgentSession | CreateSessionForSubagentResult): NormalizedSubagentSession {
  if ('session' in result) {
    return {
      session: result.session,
      dispose: result.dispose ?? (async () => {}),
      hooks: result.hooks,
      sessionId: result.sessionId,
      agentDir: result.agentDir,
      origin: result.origin,
      getTranscriptPath: result.getTranscriptPath,
      backgroundDrain: result.backgroundDrain,
    }
  }
  return {
    session: result,
    dispose: async () => {},
    hooks: undefined,
    sessionId: undefined,
    agentDir: undefined,
    origin: undefined,
    getTranscriptPath: undefined,
    backgroundDrain: undefined,
  }
}

export type InvokeSubagentOptions = {
  registry: SubagentRegistry
  createSessionForSubagent?: CreateSessionForSubagent
  agentDir: string
  userPrompt: string
  payload?: unknown
  parentSessionId?: string
  spawnedByRole?: string
  spawnedByOrigin?: SessionOrigin
  onProviderError?: (errorMessage: string) => void
  // Fires synchronously after the AgentSession is created and before
  // session.prompt() is invoked, with both the live session reference and
  // its allocated sessionId. The only consumer in production is the spawn
  // tool's LiveSubagentRegistry path, which uses it to attach a progress
  // subscriber and register the abort handle while invokeSubagent retains
  // its `Promise<void>` external contract.
  onSessionCreated?: (event: {
    session: AgentSession
    sessionId: string | undefined
    abort: () => Promise<void>
  }) => void
}

export async function invokeSubagent(name: string, options: InvokeSubagentOptions): Promise<void> {
  const subagent = options.registry[name]
  if (!subagent) throw new Error(`unknown subagent: ${name}`)

  const validatedPayload = validateSubagentPayload(name, subagent, options.payload)
  const createSessionForSubagent = options.createSessionForSubagent ?? defaultCreateSessionForSubagent
  const sessionOptions: CreateSessionForSubagentOptions = {
    name,
    ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.spawnedByRole !== undefined ? { spawnedByRole: options.spawnedByRole } : {}),
    ...(options.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
  }

  const runSession: RunSession = async (override) => {
    const { session, dispose, hooks, sessionId, agentDir, origin, getTranscriptPath, backgroundDrain } =
      normalizeSubagentSession(await createSessionForSubagent(subagent, sessionOptions))
    let aborted = false
    let drainWatch: SubagentDrainWatch | undefined
    if (options.onSessionCreated !== undefined) {
      options.onSessionCreated({
        session,
        sessionId,
        abort: async () => {
          aborted = true
          await session.abort()
        },
      })
    }
    const unsubProviderErrors =
      options.onProviderError !== undefined
        ? subscribeProviderErrors(session, (err) => options.onProviderError!(err.message))
        : null
    const turnEvent =
      hooks && sessionId !== undefined && agentDir !== undefined
        ? { sessionId, agentDir, ...(origin !== undefined ? { origin } : {}) }
        : undefined
    const userPromptForTurn = override?.userPrompt ?? options.userPrompt
    // Per-turn memory injection for vector agents: subagents have no
    // system-prompt `# Memory` section (their prompt is a systemPromptOverride),
    // so the turn-start hook renders memory into `retrievalContext.results`,
    // appended to the user turn below. Empty for non-vector agents.
    const retrievalContext = { results: '' }
    try {
      if (hooks && turnEvent !== undefined) {
        await hooks.runSessionTurnStart({ ...turnEvent, userPrompt: userPromptForTurn, retrievalContext })
      }
      if (backgroundDrain !== undefined) {
        drainWatch = beginSubagentDrainWatch(backgroundDrain)
      }
      try {
        const turnText =
          retrievalContext.results.length > 0
            ? `${renderTurnTimeAnchor()}\n\n${userPromptForTurn}\n\n${retrievalContext.results}`
            : `${renderTurnTimeAnchor()}\n\n${userPromptForTurn}`
        await session.prompt(turnText)
      } finally {
        if (hooks && turnEvent !== undefined) {
          await hooks.runSessionTurnEnd(turnEvent)
        }
      }
      if (drainWatch !== undefined && backgroundDrain !== undefined) {
        await runSubagentDrain(drainWatch, {
          drain: backgroundDrain,
          prompt: async (text) => {
            await session.prompt(`${renderTurnTimeAnchor()}\n\n${text}`)
          },
          cancelled: () => aborted,
        })
      }
      if (hooks && sessionId !== undefined) {
        await hooks.runSessionIdle({
          sessionId,
          parentTranscriptPath: getTranscriptPath?.(),
          idleMs: 0,
          ...(origin !== undefined ? { origin } : {}),
        })
      }
    } finally {
      unsubProviderErrors?.()
      if (hooks && sessionId !== undefined) {
        await hooks.runSessionEnd({ sessionId, ...(origin !== undefined ? { origin } : {}) })
      }
      drainWatch?.stop()
      session.dispose()
      await dispose()
    }
  }

  if (subagent.handler) {
    const ctx = {
      userPrompt: options.userPrompt,
      agentDir: options.agentDir,
      payload: validatedPayload,
    }
    await subagent.handler(ctx, runSession)
  } else {
    await runSession()
  }
}

export class SubagentTimeoutError extends Error {
  override readonly name = 'SubagentTimeoutError'
  constructor(
    readonly subagentName: string,
    readonly coalesceKey: string,
    readonly timeoutMs: number,
  ) {
    super(`subagent ${subagentName} (key=${coalesceKey}) spawn timed out after ${timeoutMs}ms`)
  }
}

export function isSubagentTimeoutError(err: unknown): err is SubagentTimeoutError {
  return err instanceof SubagentTimeoutError
}

export async function awaitWithSubagentTimeout(
  work: Promise<void>,
  subagentName: string,
  coalesceKey: string,
  timeoutMs: number | undefined,
): Promise<void> {
  if (timeoutMs === undefined) {
    await work
    return
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubagentTimeoutError(subagentName, coalesceKey, timeoutMs)), timeoutMs)
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export type SubagentHandle = {
  taskId: string
  sessionId: string | undefined
  abort: () => Promise<void>
}

export type StartSubagentResult = {
  handle: Promise<SubagentHandle>
  completion: Promise<{ ok: true; finalMessage?: string } | { ok: false; error: string; finalMessage?: string }>
}

export type StartSubagentOptions = InvokeSubagentOptions & {
  taskId: string
  onSession?: (event: { session: AgentSession; sessionId: string | undefined; abort: () => Promise<void> }) => void
}

// Non-blocking alternative to invokeSubagent. Returns immediately with two
// promises:
// - `handle` resolves with { taskId, sessionId, abort } once the AgentSession
//   has been created (typically the first microtask). The taskId is what the
//   caller chose; sessionId is allocated by the session factory.
// - `completion` resolves when the subagent's prompt finishes, ok=true with
//   an optional final message, or ok=false with an error message.
// The two promises share a single underlying invokeSubagent invocation;
// `completion` settles after dispose, so the session reference exposed via
// `handle.abort` becomes a no-op once `completion` resolves.
//
// `timeoutMs` enforcement: the `spawn_subagent` tool drives its background
// `subagent.completed` broadcast off this `completion` promise, so an
// unbounded `invokeSubagent` (a wedged `session.prompt` that never settles)
// would leave `completion` pending forever and the parent never woken. When
// the subagent declares `timeoutMs`, we race the work against a ceiling and
// settle `completion` with `ok: false` on expiry — which fires the FAILED
// broadcast so the parent learns the spawn died instead of hanging silently.
// This mirrors `awaitWithSubagentTimeout` on the SubagentConsumer path; here
// the timeout resolves (rather than rejects) because `completion` already maps
// failures to `{ ok: false }`. Cancellation is best-effort: pi's
// `session.prompt` takes no AbortSignal, so we call the session `abort` handle
// (which the handle resolution captured) to tear down what we can; the LLM
// stream may keep running until the OS reaps it.
export function startSubagent(name: string, options: StartSubagentOptions): StartSubagentResult {
  let resolveHandle: (h: SubagentHandle) => void
  let rejectHandle: (err: Error) => void
  const handle = new Promise<SubagentHandle>((resolve, reject) => {
    resolveHandle = resolve
    rejectHandle = reject
  })
  let handleSettled = false
  let finalMessage: string | undefined
  let abortSession: (() => Promise<void>) | undefined

  const work = invokeSubagent(name, {
    ...options,
    onSessionCreated: (event) => {
      handleSettled = true
      abortSession = event.abort
      resolveHandle({ taskId: options.taskId, sessionId: event.sessionId, abort: event.abort })
      if (options.onSession !== undefined) {
        options.onSession(event)
      }
      attachFinalMessageCapture(event.session, (msg) => {
        finalMessage = msg
      })
    },
  })
    .then(() => ({ ok: true as const, ...(finalMessage !== undefined ? { finalMessage } : {}) }))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      if (!handleSettled) {
        rejectHandle(err instanceof Error ? err : new Error(error))
      }
      return { ok: false as const, error }
    })

  const timeoutMs = options.registry[name]?.timeoutMs
  const completion =
    timeoutMs === undefined ? work : raceSubagentCompletion(work, name, options.taskId, timeoutMs, () => finalMessage)

  void completion.then(() => {
    if (timeoutMs !== undefined) void abortSession?.()
  })

  return { handle, completion }
}

type SubagentCompletion = { ok: true; finalMessage?: string } | { ok: false; error: string; finalMessage?: string }

// `getFinalMessage` is read INSIDE the timeout callback, not at race-construction
// time, so the timed-out result carries whatever the subagent had captured by the
// moment the timer fired (e.g. a researcher's `<report>` block emitted just before
// the kill). JS is single-threaded, so this read is torn-free; it preserves only
// what an assistant `message_end` already committed — a result still mid-stream
// when the timer fires cannot be recovered. The outcome stays `ok: false`: a
// timeout is a lifecycle failure, and `finalMessage` here is recovery data for
// the parent to inspect/re-persist, not proof the subagent honored its contract.
function raceSubagentCompletion(
  work: Promise<SubagentCompletion>,
  name: string,
  taskId: string,
  timeoutMs: number,
  getFinalMessage: () => string | undefined,
): Promise<SubagentCompletion> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<SubagentCompletion>((resolve) => {
    timer = setTimeout(() => {
      const finalMessage = getFinalMessage()
      resolve({
        ok: false,
        error: new SubagentTimeoutError(name, taskId, timeoutMs).message,
        ...(finalMessage !== undefined ? { finalMessage } : {}),
      })
    }, timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

// A complete <review>...</review> block. The reviewer's contract is that this
// block IS its result; same-message preamble/trailing chatter or a later
// summary turn must not become the captured final message. `[\s\S]` spans
// newlines (the block is multi-line); non-greedy stops at the first close so an
// incidental `<review>` literal in reviewed text cannot swallow real content.
// Global so a message with several blocks yields the last (the revision).
const REVIEW_BLOCK_RE = /<review>[\s\S]*?<\/review>/g

function lastReviewBlock(text: string): string | null {
  const matches = text.match(REVIEW_BLOCK_RE)
  return matches === null ? null : (matches[matches.length - 1] ?? null)
}

function attachFinalMessageCapture(session: AgentSession, onFinalMessage: (msg: string) => void): void {
  let lastAssistant: string | null = null
  let lastReview: string | null = null
  try {
    session.subscribe((event: unknown) => {
      const ev = event as { type?: string; message?: { role?: string; content?: unknown } }
      if (ev?.type !== 'message_end') return
      // Real assistant messages carry role 'assistant'; older test doubles omit
      // it. user/toolResult echoes must never overwrite the assistant's answer.
      const role = ev.message?.role
      if (role !== undefined && role !== 'assistant') return
      const text = extractFinalMessageText(ev.message?.content)
      if (text === null) return
      lastAssistant = text
      const review = lastReviewBlock(text)
      if (review !== null) lastReview = review
      onFinalMessage(lastReview ?? lastAssistant)
    })
  } catch {
    // session.subscribe is a stable upstream API; defensive try is for test
    // doubles that don't implement it.
  }
}

function extractFinalMessageText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed ? trimmed : null
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    const joined = parts.join('').trim()
    return joined ? joined : null
  }
  return null
}

export type SubagentConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type SubagentInFlightKey = (subagent: string, payload: unknown) => string

export type CreateSubagentConsumerOptions = {
  stream: Stream
  // Resolved per incoming stream message so plugin reload can swap the merged
  // registry without rebuilding the consumer.
  getRegistry: () => SubagentRegistry
  agentDir: string
  createSessionForSubagent?: CreateSessionForSubagent
  // Coalescing key. Default uses the subagent name alone, so the same subagent
  // cannot run concurrently. Override to allow per-payload concurrency (e.g.
  // memory-logger keyed by parentSessionId so different sessions run in parallel
  // while the same session deduplicates).
  inFlightKey?: SubagentInFlightKey
  logger?: SubagentConsumerLogger
}

export type SubagentConsumer = {
  start: () => void
  stop: () => void
  inFlightCount: () => number
}

const consoleLogger: SubagentConsumerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

function parseSpawnedByOriginJson(
  raw: string | undefined,
  logger: SubagentConsumerLogger,
  subagentName: string,
): SessionOrigin | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`[subagent] ${subagentName}: ignoring malformed spawnedByOriginJson on stream target: ${message}`)
    return undefined
  }
  // Shape-validate the decoded value so a malformed sender (or a future
  // bug in cron consumer's encode side) cannot poison the subagent's
  // origin with arbitrary shapes. The check is narrow: object with a
  // `kind` field whose value is one of the SessionOrigin discriminator
  // strings. Permission resolution treats unknown shapes as guest, so
  // failing closed here matches the rest of the system.
  if (!isSessionOriginShape(parsed)) {
    logger.warn(`[subagent] ${subagentName}: ignoring spawnedByOriginJson with unrecognized SessionOrigin shape`)
    return undefined
  }
  return parsed
}

// Must list EVERY SessionOrigin discriminator. `system` is included so a
// streamed memory/backup spawn (whose spawnedByOrigin is serialized to JSON
// and re-parsed here) keeps its owner-resolving origin instead of being
// dropped and silently demoted to guest — the exact regression the system
// origin exists to prevent. Keep in sync with the SessionOrigin union.
const SESSION_ORIGIN_KINDS = new Set(['tui', 'cron', 'channel', 'subagent', 'system'])
function isSessionOriginShape(value: unknown): value is SessionOrigin {
  if (value === null || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && SESSION_ORIGIN_KINDS.has(kind)
}

export function createSubagentConsumer({
  stream,
  getRegistry,
  agentDir,
  createSessionForSubagent,
  inFlightKey = (name) => name,
  logger = consoleLogger,
}: CreateSubagentConsumerOptions): SubagentConsumer {
  const inFlight = new Set<string>()
  let unsubscribe: Unsubscribe | null = null

  return {
    start() {
      if (unsubscribe !== null) return
      unsubscribe = stream.subscribe({ target: { kind: 'new-session' } }, async (msg) => {
        const target = msg.target as {
          kind: 'new-session'
          subagent: string
          parentSessionId?: string
          spawnedByRole?: string
          spawnedByOriginJson?: string
        }
        const name = target.subagent
        const registry = getRegistry()
        if (registry[name] === undefined) {
          logger.warn(`[subagent] no registered subagent "${name}", ignoring ${msg.id}`)
          return
        }
        const key = inFlightKey(name, msg.payload)
        if (inFlight.has(key)) {
          logger.warn(`[subagent] ${key}: previous run still in progress, skipping`)
          return
        }
        inFlight.add(key)
        try {
          const spawnedByOrigin = parseSpawnedByOriginJson(target.spawnedByOriginJson, logger, name)
          await awaitWithSubagentTimeout(
            invokeSubagent(name, {
              registry,
              ...(createSessionForSubagent !== undefined ? { createSessionForSubagent } : {}),
              agentDir,
              userPrompt: '',
              payload: msg.payload,
              onProviderError: (message) => logger.error(`[subagent] ${key}: LLM call failed: ${message}`),
              ...(target.parentSessionId !== undefined ? { parentSessionId: target.parentSessionId } : {}),
              ...(target.spawnedByRole !== undefined ? { spawnedByRole: target.spawnedByRole } : {}),
              ...(spawnedByOrigin !== undefined ? { spawnedByOrigin } : {}),
            }),
            name,
            key,
            registry[name]?.timeoutMs,
          )
        } catch (err) {
          if (isSubagentTimeoutError(err)) {
            logger.warn(`[subagent] ${key} timed out after ${err.timeoutMs}ms; releasing coalesce key`)
          } else {
            const message = err instanceof Error ? err.message : String(err)
            logger.error(`[subagent] ${key} failed: ${message}`)
          }
        } finally {
          inFlight.delete(key)
        }
      })
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
    inFlightCount() {
      return inFlight.size
    },
  }
}
