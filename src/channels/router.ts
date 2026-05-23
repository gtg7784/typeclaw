import { basename } from 'node:path'

import type { AssistantMessage } from '@mariozechner/pi-ai'
import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession, type AgentSession } from '@/agent'
import { subscribeProviderErrors } from '@/agent/provider-error'
import type { ChannelParticipant, SessionOrigin } from '@/agent/session-origin'
import { renderSubagentCompletionReminder } from '@/agent/subagent-completion-reminder'
import { createCommandRegistry } from '@/commands'
import { CORE_PERMISSIONS, type PermissionService } from '@/permissions'
import type { HookBus } from '@/plugin'
import { extractClaimCode } from '@/role-claim'

import { decideEngagement, grantStickyForReplyTargets, StickyLedger, type EngagementDecision } from './engagement'
import {
  MEMBERSHIP_COLD_FETCH_TIMEOUT_MS,
  type MembershipCount,
  type MembershipResolver,
  type MembershipResolverResult,
} from './membership'
import { createMembershipCache, type MembershipCache } from './membership-cache'
import { updateParticipants } from './participants'
import {
  channelsSessionsPath,
  findRecord,
  loadChannelSessions,
  saveChannelSessions,
  type ChannelSessionRecord,
} from './persistence'
import type { ChannelAdapterConfig } from './schema'
import type {
  ChannelHistoryMessage,
  ChannelKey,
  ChannelNameResolver,
  FetchAttachmentArgs,
  FetchAttachmentCallback,
  FetchAttachmentResult,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  InboundMessage,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
  TypingCallback,
} from './types'
import { channelKeyId } from './types'

export const INITIAL_DEBOUNCE_MS = 600
export const HOT_DEBOUNCE_MS = 1500
export const MAX_DEBOUNCE_MS = 4000
export const HOT_THRESHOLD_MS = 3000
export const MAX_CONSECUTIVE_ABORTS = 3
export const CONTEXT_BUFFER_SIZE = 20
// Discord's typing indicator expires after ~10s; an 8s heartbeat keeps it
// continuously visible while we debounce + generate without spamming the API.
export const TYPING_HEARTBEAT_MS = 8000
// A stuck model call or an agent that never yields should not keep re-arming
// platform-side typing forever. Slack Assistant status in particular has a
// documented 2-minute timeout, so repeatedly refreshing it after that point
// turns a temporary status into a permanent-looking artifact.
export const MAX_TYPING_HEARTBEAT_MS = 2 * 60 * 1000

// Idle GC: a LiveSession whose `lastInboundAt` is older than
// SESSION_IDLE_MS gets evicted on the next GC tick. Persistence
// (channels/sessions.json) is intentionally untouched — the next inbound
// rehydrates from disk against the same sessionId, so the on-disk
// transcript continues across the eviction. The point is to free memory
// (LiveSession holds an open SessionManager + transcript in RAM) and to
// give the next conversation a fresh start without forcing the user to
// notice anything. `lastInboundAt` is bumped only by *engaged* inbounds
// (see scheduleDebouncedDrain), so passive observation alone won't keep
// a session warm forever — that's intentional. The session is seeded
// with `now()` at creation (not `0`) so a freshly-created observe-only
// session gets a full SESSION_IDLE_MS window before its first GC sweep,
// not a 56-year-old idle reading from `Date.now() - 0`.
export const SESSION_IDLE_MS = 30 * 60 * 1000
export const SESSION_GC_INTERVAL_MS = 60 * 1000

// Hard cap on tool-initiated outbound sends per (chat:thread) per turn.
// The original loop-incident emitted ~50 sends in one turn; even
// legitimate split replies rarely cross 8. 10 leaves headroom for
// genuine multi-part answers while definitively stopping runaway loops.
// Enforced inside router.send for `source: 'tool'` callers; system
// recovery paths (`source: 'system'`) bypass.
export const MAX_CHANNEL_SENDS_PER_TURN = 10
// Rolling window for outbound send-rate telemetry. 5s matches Discord's
// rate-limit shape (5 msg / 5 s / channel) and comfortably covers Slack's
// 1 msg/s sustained. The window is observational; exceeding the burst
// threshold below escalates the per-send log to a warning.
export const SEND_RATE_WINDOW_MS = 5_000
// Above this in-window count, the per-send log line escalates to a
// `send_rate_warning` so a burst stands out in the log stream. Every
// send still emits a structured log line regardless of rate — this
// constant only controls when the warning marker appears.
export const SEND_RATE_WARN_THRESHOLD = 3

/**
 * Maximum age of the last engaged inbound before the next inbound triggers a fresh session.
 * Set to the LLM provider's KV-cache TTL (5 min) so the new session's system prompt is
 * guaranteed to be a cache hit on the provider side.
 *
 * Unlike SESSION_IDLE_MS (which evicts the in-memory entry without rollover), this constant
 * triggers a full tearDownLive + recreate on the next engaged inbound. The old session's
 * transcript is preserved on disk; only the in-memory live entry and sessions.json pointer
 * are replaced.
 */
export const SESSION_FRESHNESS_TTL_MS = 5 * 60 * 1000

// Watchdog ceiling for ensureLive's full async chain (resolve names →
// fetch membership → open session manager → persist mapping → prefetch
// history). A legitimate cold-start completes in well under a second;
// values above ~10s are always either a hung Discord REST call or a
// rate-limited retry storm. 30s leaves headroom for slow disks or a
// truly large transcript replay without making operator-noticed hangs
// indistinguishable from normal latency. On timeout the throw evicts
// the `creating` map entry so the next inbound retries from scratch
// instead of awaiting the same dead promise forever.
export const ENSURE_LIVE_TIMEOUT_MS = 30_000

// Per-callback ceilings inside the ensureLive chain. The outer watchdog
// catches the worst case, but per-step timeouts give better log
// attribution (which step hung) AND graceful degradation: a hung name
// resolver still lets engagement run on IDs alone, a hung history fetch
// still lets the agent answer without prefetched context. Both paths
// loop over registered callbacks and currently `await` each unbounded.
// 5s matches Discord's median REST p99 with comfortable headroom.
export const RESOLVE_CHANNEL_NAMES_TIMEOUT_MS = 5_000
export const FETCH_HISTORY_TIMEOUT_MS = 5_000

// Watchdog over the whole session.idle hook chain. The drain loop awaits
// `fireSessionIdle` between turns; a single hung plugin handler (e.g. a
// memory-logger awaiting a network call that never resolves) wedges the
// loop with `live.draining` stuck `true`, which means subsequent mention
// inbounds enqueue silently and never fire. Observe-decisions still log
// because engagement runs in `route()` before the draining check, so the
// symptom from logs alone is "thread receives observed lines forever
// after the last `prompted elapsed_ms=...`". Bounding the chain here
// matches the ensureLive watchdog (30s) so a misbehaving plugin
// degrades the current turn instead of bricking the channel until
// container restart. Per-handler attribution lives in plugin/hooks.ts.
export const SESSION_IDLE_TIMEOUT_MS = 30_000

// Two-axis loop guard for peer-bot conversation. Peer bots route into
// engagement under the SAME rules as humans, so a small ring (A→B→C→A) or
// a fast cascade can otherwise ping-pong without bound. The guard trips
// when EITHER axis hits its limit and clears on the next human inbound.
//
// Why two axes:
// - The since-human counter catches slow rings that would never fill a
//   60s window (3 bots replying every 30s = 4 turns/min, never trips a
//   60s sliding count).
// - The 60s window catches fast bursts that would never accumulate enough
//   total turns to pressure the since-human counter (a single bot reflex
//   replying to its own mention 5x in 2s).
//
// The model receives a non-fatal warning prepended into composeTurnPrompt
// when tripped; the LLM decides whether to keep replying. Hard interrupt
// is intentionally not part of v1 (would require pi-coding-agent abort
// semantics during in-flight tool calls).
export const PEER_BOT_TURNS_WINDOW_MS = 60_000
export const MAX_PEER_BOT_TURNS_IN_WINDOW = 5
export const MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN = 5

export type RouterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: RouterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type CreateSessionForChannel = (params: {
  key: ChannelKey
  existingSessionId?: string
  // Basename of the JSONL file the prior session wrote to, captured at
  // creation time and persisted in channels/sessions.json. Used for
  // reopening — without this, sessionId alone is insufficient because
  // pi-coding-agent prefixes filenames with an ISO timestamp at write time
  // that the UUID does not encode. Optional for forward-compat with v2
  // mappings that predate the `sessionFile` field.
  existingSessionFile?: string
  participants: readonly ChannelParticipant[]
  origin: SessionOrigin
  // Mutable holder the router updates per turn (with the current turn's
  // lastInboundAuthorId, participants, etc.) so tool.before events stamp
  // the live actor identity rather than the cold-start snapshot. The
  // factory is expected to pass this through to createSession as
  // `options.originRef`.
  originRef: { current: SessionOrigin | undefined }
}) => Promise<{
  session: AgentSession
  sessionId: string
  dispose: () => Promise<void>
  hooks?: HookBus
  getTranscriptPath?: () => string | undefined
}>

export type ConfigForAdapter = (adapter: ChannelKey['adapter']) => ChannelAdapterConfig | undefined

type QueuedInbound = {
  text: string
  authorId: string
  authorName: string
  authorIsBot: boolean
  externalMessageId: string
  isBotMention: boolean
  replyToBotMessageId: string | null
  isDm: boolean
  receivedAt: number
  // Original platform timestamp (Slack/Discord), in ms since epoch. Used
  // by composeTurnPrompt to render an ISO 8601 prefix on each line so the
  // model sees when each message was actually posted, not when the router
  // happened to dequeue it. Zero means "unknown" (the formatter omits the
  // prefix for those).
  ts: number
}

type ObservedInbound = {
  text: string
  authorId: string
  authorName: string
  authorIsBot: boolean
  receivedAt: number
  ts: number
}

type LiveSession = {
  key: ChannelKey
  keyId: string
  session: AgentSession
  sessionId: string
  dispose: () => Promise<void>
  hooks: HookBus | undefined
  getTranscriptPath: (() => string | undefined) | undefined
  participants: ChannelParticipant[]
  resolvedNames: ResolvedChannelNames
  originRef: { current: SessionOrigin | undefined }
  promptQueue: QueuedInbound[]
  contextBuffer: ObservedInbound[]
  draining: boolean
  debounceTimer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setInterval> | null
  typingStartedAt: number
  typingTimedOut: boolean
  typingStopPromise: Promise<void> | null
  lastInboundAt: number
  firstUnprocessedAt: number
  currentTurnAuthorId: string | null
  currentTurnAuthorIds: Set<string>
  lastTurnAuthorIds: Set<string>
  consecutiveAborts: number
  // Per-(chat:thread) count of bot messages sent without intervening user
  // input being rendered into the model's context. Reset at the top of each
  // drain() iteration that picks up a non-empty batch (= a new user turn is
  // about to be shown to the model). channel_send reads this BEFORE calling
  // router.send so the hint reflects the position of the about-to-happen send
  // (n-th in a row), nudging the model to yield without forcing it to.
  // Queue of `<system-reminder>...</system-reminder>` strings to prepend
  // into the next turn's user-message body. Populated by
  // `injectSubagentCompletionReminder` (and any future system-injected
  // wakeups) so a backgrounded subagent's completion can wake a channel
  // session that has no pending user inbounds. Drained at the top of
  // every `drain()` iteration alongside the regular promptQueue batch;
  // the drain loop's run condition checks BOTH queues so a system
  // reminder alone is enough to trigger a turn.
  pendingSystemReminders: string[]
  consecutiveSends: Map<string, number>
  // Per-(chat:thread) text of the last reserved bot send. Set
  // SYNCHRONOUSLY inside router.send before the outbound callback awaits,
  // so two concurrent `router.send` calls for the same target cannot both
  // pass the duplicate guard. Cleared on every new prompt batch (same
  // lifecycle as `consecutiveSends`). The scope is "last 1 send within
  // this turn" so legitimate multi-part replies (different bodies) and
  // across-turn callbacks ("yes, I'm here" twice) are not blocked. Empty
  // strings are normalized to undefined before storage so attachments-only
  // sends never poison the tracker. The fuzzy-match upgrade is intentionally
  // deferred — exact-match has zero false-positive risk by construction.
  lastSentText: Map<string, string>
  // Per-(chat:thread) ring of send timestamps (epoch ms) within the rolling
  // SEND_RATE_WINDOW_MS window. Append-on-send, prune-on-read. Lifecycle is
  // wall-clock (NOT cleared on new prompt batches) because rate is a
  // property of the channel over time, not the agent's turn structure — a
  // burst that straddles two adjacent turns is still a burst from the chat
  // platform's POV. Telemetry-only today; the rate is logged when count
  // crosses SEND_RATE_LOG_THRESHOLD so production data can inform a
  // future hard cap without picking a threshold out of thin air.
  sendTimestamps: Map<string, number[]>
  successfulChannelSends: number
  // Loop-guard state. See PEER_BOT_TURNS_WINDOW_MS / MAX_* constants
  // above. Updated in route() on every engaged peer-bot inbound, reset on
  // any human inbound. The two axes (window ring buffer + since-human
  // counter) are independent — either tripping sets `loopGuardActive`
  // until the next human posts. The active flag is read by
  // composeTurnPrompt() and prepended to the user-turn text.
  recentEngagedPeerBotTurns: { authorId: string; ts: number }[]
  consecutiveEngagedPeerBotTurns: number
  loopGuardActive: boolean
  membershipFetch: Promise<MembershipCount | null> | null
  destroyed: boolean
  unsubProviderErrors: (() => void) | null
}

// `event` is null for command invocations that originated outside the inbound
// pipeline (e.g. Discord native slash commands fired from listener.on
// ('interaction_create')). Handlers that need a real inbound — for some
// future hypothetical command like `/quote` — must guard on event !== null
// instead of assuming it.
type ChannelCommandContext = {
  live: LiveSession
  event: InboundMessage | null
}

export type ExecuteCommandResult =
  | { kind: 'handled'; name: string }
  | { kind: 'unknown-command'; name: string }
  | { kind: 'no-live-session' }
  | { kind: 'permission-denied' }
  | { kind: 'ambiguous'; matchCount: number }

// Identifies who invoked an adapter-driven command. Required so the router
// can run the same channel.respond permission gate the text-prefix command
// path runs (isChannelRespondDenied in route()). Without it, a guest user
// in a public Slack channel could /stop an owner-created session that
// happened to be live, bypassing role gating entirely.
export type ExecuteCommandOptions = {
  invokerId: string
}

export type SendSource = 'tool' | 'system'

export type SendOptions = {
  source?: SendSource
}

export const DUPLICATE_SEND_ERROR =
  'Duplicate not sent. Do not call channel_send/channel_reply again this turn. ' +
  'End with NO_REPLY unless you have genuinely new, non-redundant information.'

export const TURN_CAP_ERROR =
  `Send-cap reached for this turn (${MAX_CHANNEL_SENDS_PER_TURN} messages already sent to this conversation). ` +
  'End your turn now. The user can prompt you again for more output.'

export type ChannelRouter = {
  route: (event: InboundMessage) => Promise<void>
  send: (msg: OutboundMessage, opts?: SendOptions) => Promise<SendResult>
  getConsecutiveSendCount: (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }) => number
  getSendRate: (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }) => { count: number; windowMs: number }
  registerOutbound: (adapter: ChannelKey['adapter'], cb: OutboundCallback) => void
  unregisterOutbound: (adapter: ChannelKey['adapter'], cb: OutboundCallback) => void
  registerTyping: (adapter: ChannelKey['adapter'], cb: TypingCallback) => void
  unregisterTyping: (adapter: ChannelKey['adapter'], cb: TypingCallback) => void
  registerChannelNameResolver: (adapter: ChannelKey['adapter'], resolver: ChannelNameResolver) => void
  unregisterChannelNameResolver: (adapter: ChannelKey['adapter'], resolver: ChannelNameResolver) => void
  registerMembership: (adapter: ChannelKey['adapter'], resolver: MembershipResolver) => void
  unregisterMembership: (adapter: ChannelKey['adapter'], resolver: MembershipResolver) => void
  registerHistory: (adapter: ChannelKey['adapter'], cb: HistoryCallback) => void
  unregisterHistory: (adapter: ChannelKey['adapter'], cb: HistoryCallback) => void
  fetchHistory: (adapter: ChannelKey['adapter'], args: FetchHistoryArgs) => Promise<FetchHistoryResult>
  registerFetchAttachment: (adapter: ChannelKey['adapter'], cb: FetchAttachmentCallback) => void
  unregisterFetchAttachment: (adapter: ChannelKey['adapter'], cb: FetchAttachmentCallback) => void
  fetchAttachment: (adapter: ChannelKey['adapter'], args: FetchAttachmentArgs) => Promise<FetchAttachmentResult>
  // Execute a command by name against an existing live session, bypassing
  // the inbound classifier, engagement gate, debounce, and prompt queue.
  // Used by adapters that receive commands through a native surface
  // (Discord application-command interactions) rather than text. Gates
  // the invoker on channel.respond — same permission gate the text-prefix
  // command path runs — so a guest user cannot abort an owner's session
  // by clicking the slash-command picker. Adapters MUST forward the
  // invoker's platform-specific user id; without it the gate cannot
  // identify the actor and resolves to 'guest' which denies. Returns:
  //   - handled: command ran
  //   - permission-denied: invoker lacks channel.respond
  //   - no-live-session: channel has no active session
  //   - ambiguous: multiple thread-keyed sessions in same chat (Slack);
  //     caller should refuse to act rather than abort an arbitrary one
  //   - unknown-command: name is not registered
  executeCommand: (key: ChannelKey, name: string, options: ExecuteCommandOptions) => Promise<ExecuteCommandResult>
  // Lowered self-aliases (configured + implicit dir-name). Adapters use
  // this to anchor outbound threading on alias-only inbounds — see
  // slack-bot-classify.ts. Read live so a reload of `alias` propagates
  // to adapters without a restart.
  getSelfAliases: () => readonly string[]
  // Inject a `<system-reminder>` block addressed to a live channel session
  // identified by `parentSessionId`. The reminder is rendered into the
  // next turn's user-message body and triggers a drain even if the
  // promptQueue is empty. Returns `delivered` when a matching live
  // session was found and the reminder was queued, `no-live-session`
  // otherwise. Used by the subagent-completion bridge in
  // src/run/index.ts; safe for tests to call directly via a fake router.
  injectSubagentCompletionReminder: (args: {
    parentSessionId: string
    subagent: string
    taskId: string
    ok: boolean
    durationMs: number
    error?: string
  }) => { kind: 'delivered'; keyId: string } | { kind: 'no-live-session' }
  stop: () => Promise<void>
  liveCount: () => number
  __testing?: {
    flushDebounce: (key: ChannelKey) => Promise<void>
    fireTypingHeartbeat: (key: ChannelKey, phase?: 'tick' | 'stop') => Promise<void>
    fireTypingInterval: (key: ChannelKey) => Promise<void>
    isTypingActive: (key: ChannelKey) => boolean
    stopTyping: (key: ChannelKey) => Promise<void>
    runIdleGc: () => Promise<void>
  }
}

// Returns the additional aliases the agent answers to (beyond the
// implicit dir-name). Read from the live config every inbound — `alias`
// is classified `applied` in FIELD_EFFECTS, so a `reload` should change
// engagement behavior immediately. Defaults to an empty list when not
// provided, which means alias-based engagement is effectively off (the
// dir-name is still implicit and added by the router below).
export type AliasesProvider = () => readonly string[]

export type CreateChannelRouterOptions = {
  agentDir: string
  configForAdapter: ConfigForAdapter
  configuredAliases?: AliasesProvider
  createSessionForChannel?: CreateSessionForChannel
  sessionDir?: string
  logger?: RouterLogger
  // Test seam: clock for sticky/debounce/participants. Defaults to Date.now.
  now?: () => number
  // Test seam: override the ensureLive watchdog ceiling so the timeout path
  // is exercisable in <100ms instead of the 30s production default.
  ensureLiveTimeoutMs?: number
  // Test seam: per-callback ceiling for channel name resolvers; mirrors the
  // ensureLive seam so timeout paths can be exercised quickly in tests.
  resolveChannelNamesTimeoutMs?: number
  // Test seam: per-callback ceiling for history fetches.
  fetchHistoryTimeoutMs?: number
  // Test seam: bound the session.idle hook chain so the timeout path is
  // exercisable in tens of milliseconds instead of the 30s default.
  sessionIdleTimeoutMs?: number
  // Wake-up gate: every inbound is gated by `permissions.has(partialOrigin,
  // 'channel.respond')` BEFORE ensureLive. Required by the production
  // wiring (manager.ts forwards `pluginsLoaded.permissions`); defaulted
  // to a grant-all service inside the factory so existing direct test
  // instantiations don't need to inject one. The default is intentionally
  // permissive — the manager-to-router seam is the place where production
  // injection is enforced; direct-router tests opt into gate semantics by
  // passing their own service.
  permissions?: PermissionService
  // Optional role-claim handler. When set, the router intercepts DM
  // inbounds whose text contains a claim code BEFORE the channel.respond
  // gate, hands the inbound to the handler, and short-circuits the normal
  // route path (no session creation, no permission check, no engagement
  // pipeline). The handler returns the reply text the router should send
  // back over the same chat, or null to fall through to normal routing
  // when no pending claim window matches.
  claimHandler?: ClaimHandler
}

export type ClaimHandlerInput = {
  adapter: ChannelKey['adapter']
  workspace: string
  chat: string
  isDm: boolean
  authorId: string
  text: string
}

export type ClaimHandlerOutcome =
  | { kind: 'consumed'; reply: string }
  | { kind: 'fail'; reply: string }
  | { kind: 'fallthrough' }

export type ClaimHandler = (input: ClaimHandlerInput) => Promise<ClaimHandlerOutcome>

const GRANT_ALL_PERMISSIONS: PermissionService = {
  has: () => true,
  resolveRole: () => 'owner',
  describe: () => ({ role: 'owner', permissions: [CORE_PERMISSIONS.channelRespond] }),
  replaceRoles: () => {},
}

export function createChannelRouter(options: CreateChannelRouterOptions): ChannelRouter {
  const logger = options.logger ?? consoleLogger
  const now = options.now ?? Date.now
  const ensureLiveTimeoutMs = options.ensureLiveTimeoutMs ?? ENSURE_LIVE_TIMEOUT_MS
  const resolveChannelNamesTimeoutMs = options.resolveChannelNamesTimeoutMs ?? RESOLVE_CHANNEL_NAMES_TIMEOUT_MS
  const fetchHistoryTimeoutMs = options.fetchHistoryTimeoutMs ?? FETCH_HISTORY_TIMEOUT_MS
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS
  const permissions = options.permissions ?? GRANT_ALL_PERMISSIONS
  const claimHandler = options.claimHandler
  const liveSessions = new Map<string, LiveSession>()
  const creating = new Map<string, Promise<LiveSession>>()
  const outboundCallbacks = new Map<ChannelKey['adapter'], Set<OutboundCallback>>()
  const typingCallbacks = new Map<ChannelKey['adapter'], Set<TypingCallback>>()
  const channelNameResolvers = new Map<ChannelKey['adapter'], Set<ChannelNameResolver>>()
  const membershipResolvers = new Map<ChannelKey['adapter'], Set<MembershipResolver>>()
  const membershipCaches = new Map<ChannelKey['adapter'], MembershipCache>()
  const historyCallbacks = new Map<ChannelKey['adapter'], Set<HistoryCallback>>()
  const fetchAttachmentCallbacks = new Map<ChannelKey['adapter'], Set<FetchAttachmentCallback>>()
  const stickyLedger = new StickyLedger()
  const commands = createCommandRegistry<ChannelCommandContext>([
    {
      name: 'stop',
      handler: async ({ live }) => {
        await stopCurrentChannelTurn(live)
      },
    },
  ])

  // Implicit dir-name alias: agent folder basename matches Docker
  // container name (per AGENTS.md), the typical Discord/Slack bot
  // username, and the natural way the operator refers to the agent.
  // Lowered once at construction since basename(agentDir) doesn't change
  // over the router's lifetime; configured aliases are lowered per-call
  // because they're read from live config.
  const dirAlias = basename(options.agentDir).toLocaleLowerCase()
  const computeSelfAliases = (): readonly string[] => {
    const configured = options.configuredAliases?.() ?? []
    const set = new Set<string>([dirAlias])
    for (const a of configured) {
      const lower = a.toLocaleLowerCase()
      if (lower !== '') set.add(lower)
    }
    return Array.from(set)
  }

  let mappings: ChannelSessionRecord[] | null = null
  let loadOnce: Promise<void> | null = null
  let persistChain: Promise<void> = Promise.resolve()

  const ensureLoaded = async (): Promise<void> => {
    if (mappings !== null) return
    if (loadOnce === null) {
      loadOnce = loadChannelSessions(options.agentDir, logger).then((records) => {
        mappings = records
      })
    }
    await loadOnce
  }

  const persist = async (): Promise<void> => {
    if (mappings === null) return
    persistChain = persistChain.then(async () => {
      if (mappings === null) return
      await saveChannelSessions(options.agentDir, mappings, logger)
    })
    await persistChain
  }

  const createForChannel: CreateSessionForChannel =
    options.createSessionForChannel ??
    (async ({ key, existingSessionId, existingSessionFile, origin, originRef }) => {
      const sessionDir = options.sessionDir ?? `${options.agentDir}/sessions`
      const sessionManager =
        existingSessionId !== undefined
          ? tryOpenSessionManager(options.agentDir, sessionDir, existingSessionId, existingSessionFile, logger)
          : SessionManager.create(options.agentDir, sessionDir)
      const session = await createSession({
        sessionManager,
        origin,
        originRef,
      })
      const sessionId = sessionManager.getSessionId()
      void key
      return {
        session,
        sessionId,
        dispose: async () => {
          session.dispose()
        },
        getTranscriptPath: () => sessionManager.getSessionFile(),
      }
    })

  const resolveChannelNames = async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    const resolvers = channelNameResolvers.get(key.adapter)
    if (!resolvers || resolvers.size === 0) return {}
    const snapshot = Array.from(resolvers)
    const merged: ResolvedChannelNames = {}
    for (const resolver of snapshot) {
      try {
        const result = await raceWithTimeout(
          resolver(key),
          resolveChannelNamesTimeoutMs,
          `[channels] ${channelKeyId(key)}: name resolver`,
        )
        if (result.chatName !== undefined && merged.chatName === undefined) merged.chatName = result.chatName
        if (result.workspaceName !== undefined && merged.workspaceName === undefined) {
          merged.workspaceName = result.workspaceName
        }
      } catch (err) {
        logger.warn(`[channels] name resolver threw for ${channelKeyId(key)}: ${describe(err)}`)
      }
    }
    return merged
  }

  const readMembership = (key: ChannelKey): MembershipCount | null => {
    if (key.workspace === '@dm') return dmMembership(now())
    return membershipCaches.get(key.adapter)?.get(key) ?? null
  }

  const warmMembership = (key: ChannelKey): Promise<MembershipCount | null> | null => {
    if (key.workspace === '@dm') return Promise.resolve(dmMembership(now()))
    const cache = membershipCaches.get(key.adapter)
    if (cache === undefined) return null
    return cache.warmUp(key)
  }

  const resolveThroughRegisteredMembership = async (key: ChannelKey): Promise<MembershipResolverResult> => {
    const resolvers = membershipResolvers.get(key.adapter)
    if (!resolvers || resolvers.size === 0) return { kind: 'transient' }
    const snapshot = Array.from(resolvers)
    let lastFailure: MembershipResolverResult = { kind: 'transient' }
    for (const resolver of snapshot) {
      const result = await resolver(key)
      if ('humans' in result) return result
      lastFailure = result
    }
    return lastFailure
  }

  const membershipForPrompt = async (
    key: ChannelKey,
    fetchPromise: Promise<MembershipCount | null> | null,
  ): Promise<MembershipCount | null> => {
    if (key.workspace === '@dm') return dmMembership(now())
    const cached = readMembership(key)
    if (cached !== null) return cached
    if (fetchPromise === null) return null
    return await withMembershipTimeout(fetchPromise, key, logger)
  }

  const membershipForEngagement = async (live: LiveSession): Promise<MembershipCount | null> => {
    if (live.key.workspace === '@dm') return dmMembership(now())
    const cache = membershipCaches.get(live.key.adapter)
    if (cache === undefined) return null

    const cached = cache.read(live.key)
    if (cached.kind === 'hit') return cached.membership
    if (cached.kind === 'stale') {
      void cache.warmUp(live.key).catch((err) => {
        logger.warn(`[channels] membership refresh failed for ${live.keyId}: ${describe(err)}`)
      })
      return cached.membership
    }

    const fetchPromise = live.membershipFetch ?? warmMembership(live.key)
    live.membershipFetch = fetchPromise
    if (fetchPromise === null) return null
    const membership = await withMembershipTimeout(fetchPromise, live.key, logger)
    if (live.membershipFetch === fetchPromise) live.membershipFetch = null
    return membership
  }

  const ensureLive = async (
    key: ChannelKey,
    triggeringMessageId?: string,
    triggeringAuthorId?: string,
  ): Promise<LiveSession> => {
    const keyId = channelKeyId(key)
    const existing = liveSessions.get(keyId)
    if (existing && !existing.destroyed) {
      const idleMs = now() - existing.lastInboundAt
      if (idleMs > SESSION_FRESHNESS_TTL_MS) {
        logger.info(`[channels] ${keyId}: stale-rollover (live: ${idleMs}ms idle)`)
        await tearDownLive(existing)
        liveSessions.delete(keyId)
        if (mappings) {
          const idx = mappings.findIndex(
            (s) =>
              s.adapter === key.adapter &&
              s.workspace === key.workspace &&
              s.chat === key.chat &&
              (s.thread ?? null) === (key.thread ?? null),
          )
          if (idx >= 0) {
            const prev = mappings[idx]!
            mappings[idx] = {
              adapter: prev.adapter,
              workspace: prev.workspace,
              chat: prev.chat,
              thread: prev.thread,
              participants: prev.participants,
              lastInboundAt: 0,
            }
            await persist()
          }
        }
      } else {
        return existing
      }
    }

    const inFlight = creating.get(keyId)
    if (inFlight) return inFlight

    const promise = (async () => {
      await ensureLoaded()
      const record = mappings ? findRecord(mappings, key) : undefined
      let resolvedRecord = record
      if (
        record?.sessionId !== undefined &&
        existing === undefined &&
        now() - (record.lastInboundAt ?? 0) > SESSION_FRESHNESS_TTL_MS
      ) {
        const idleMs = now() - (record.lastInboundAt ?? 0)
        logger.info(`[channels] ${keyId}: stale-rollover (persisted: ${idleMs}ms idle)`)
        resolvedRecord = {
          adapter: record.adapter,
          workspace: record.workspace,
          chat: record.chat,
          thread: record.thread,
          participants: record.participants,
          lastInboundAt: 0,
        }
        if (mappings) {
          const idx = mappings.findIndex(
            (s) =>
              s.adapter === key.adapter &&
              s.workspace === key.workspace &&
              s.chat === key.chat &&
              (s.thread ?? null) === (key.thread ?? null),
          )
          if (idx >= 0) {
            mappings[idx] = resolvedRecord
            await persist()
          }
        }
      }
      const phase = resolvedRecord?.sessionId === undefined ? 'cold-start' : 'rehydrate'
      logger.info(`[channels] ${keyId}: ensureLive begin (${phase})`)
      const participants = (resolvedRecord?.participants ?? []) as ChannelParticipant[]
      const membershipFetch = warmMembership(key)
      const resolvedNames = await resolveChannelNames(key)
      logger.info(`[channels] ${keyId}: ensureLive resolved-names`)
      const membership = await membershipForPrompt(key, membershipFetch)
      logger.info(`[channels] ${keyId}: ensureLive resolved-membership`)
      // The session-creation origin is what the resource loader sees when it
      // renders the role/permissions block into the system prompt. It must
      // include the triggering author so author-scoped roles
      // (`slack:T/C author:U_ME`) resolve to the same role here that the
      // channel.respond gate just admitted on. Per-turn updates after this
      // point are handled by `originRef.current = buildLiveOrigin(live)`
      // before each prompt() call.
      const origin: SessionOrigin = {
        kind: 'channel',
        adapter: key.adapter,
        workspace: key.workspace,
        ...(resolvedNames.workspaceName !== undefined ? { workspaceName: resolvedNames.workspaceName } : {}),
        chat: key.chat,
        ...(resolvedNames.chatName !== undefined ? { chatName: resolvedNames.chatName } : {}),
        thread: key.thread,
        ...(triggeringAuthorId !== undefined ? { lastInboundAuthorId: triggeringAuthorId } : {}),
        participants,
        ...(membership !== null ? { membership } : {}),
      }

      const isColdStart = resolvedRecord?.sessionId === undefined

      // The router writes into this holder before every prompt() so the
      // tool wrappers' getOrigin() sees the current-turn origin.
      const originRef: { current: SessionOrigin | undefined } = { current: origin }

      const created = await createForChannel({
        key,
        ...(resolvedRecord?.sessionId ? { existingSessionId: resolvedRecord.sessionId } : {}),
        ...(resolvedRecord?.sessionFile ? { existingSessionFile: resolvedRecord.sessionFile } : {}),
        participants,
        origin,
        originRef,
      })
      logger.info(`[channels] ${keyId}: ensureLive session-created sessionId=${created.sessionId}`)

      const transcriptPath = created.getTranscriptPath?.()
      const persistedRecord: ChannelSessionRecord = {
        adapter: key.adapter,
        workspace: key.workspace,
        chat: key.chat,
        thread: key.thread,
        sessionId: created.sessionId,
        ...(transcriptPath ? { sessionFile: basename(transcriptPath) } : {}),
        lastInboundAt: now(),
        participants,
      }
      if (mappings) {
        const idx = mappings.findIndex(
          (s) =>
            s.adapter === key.adapter &&
            s.workspace === key.workspace &&
            s.chat === key.chat &&
            (s.thread ?? null) === (key.thread ?? null),
        )
        if (idx >= 0) mappings[idx] = persistedRecord
        else mappings.push(persistedRecord)
      } else {
        mappings = [persistedRecord]
      }
      await persist()

      const live: LiveSession = {
        key,
        keyId,
        session: created.session,
        sessionId: created.sessionId,
        dispose: created.dispose,
        hooks: created.hooks,
        getTranscriptPath: created.getTranscriptPath,
        participants,
        resolvedNames,
        originRef,
        promptQueue: [],
        pendingSystemReminders: [],
        contextBuffer: [],
        draining: false,
        debounceTimer: null,
        typingTimer: null,
        typingStartedAt: 0,
        typingTimedOut: false,
        typingStopPromise: null,
        lastInboundAt: now(),
        firstUnprocessedAt: 0,
        currentTurnAuthorId: null,
        currentTurnAuthorIds: new Set(),
        lastTurnAuthorIds: new Set(),
        consecutiveAborts: 0,
        consecutiveSends: new Map(),
        lastSentText: new Map(),
        sendTimestamps: new Map(),
        successfulChannelSends: 0,
        recentEngagedPeerBotTurns: [],
        consecutiveEngagedPeerBotTurns: 0,
        loopGuardActive: false,
        membershipFetch,
        destroyed: false,
        unsubProviderErrors: null,
      }
      live.unsubProviderErrors = subscribeProviderErrors(created.session, (err) => {
        logger.error(`[channels] ${live.keyId}: LLM call failed: ${err.message}`)
      })
      liveSessions.set(keyId, live)

      if (isColdStart) {
        const adapterConfig = options.configForAdapter(key.adapter)
        if (adapterConfig) {
          await prefetchChannelContext(live, adapterConfig, triggeringMessageId)
          logger.info(`[channels] ${keyId}: ensureLive prefetched-context`)
        }
      }

      logger.info(`[channels] ${keyId}: ensureLive done (${phase})`)
      return live
    })()

    creating.set(keyId, promise)
    try {
      return await raceWithTimeout(promise, ensureLiveTimeoutMs, `[channels] ${keyId} ensureLive`)
    } catch (err) {
      // The orphaned `promise` may still settle eventually; that's OK because
      // the only side effect it produces post-timeout is a `liveSessions.set`,
      // which the next inbound's existence-check short-circuit at the top of
      // ensureLive will treat as a usable warm session — strictly better than
      // a permanent silent drop. The caller (route() in this file, ultimately
      // the adapter's outer catch) sees the timeout error and logs it.
      logger.error(`[channels] ${keyId}: ensureLive failed: ${describe(err)}`)
      throw err
    } finally {
      creating.delete(keyId)
    }
  }

  const prefetchChannelContext = async (
    live: LiveSession,
    adapterConfig: ChannelAdapterConfig,
    triggeringMessageId: string | undefined,
  ): Promise<void> => {
    const prefetch = adapterConfig.history.prefetch
    const isThread = live.key.thread !== null
    const head = isThread ? prefetch.thread.head : 0
    const tail = isThread ? prefetch.thread.tail : prefetch.channel.tail
    if (head === 0 && tail === 0) return

    // One fetch per cold start. We always pass the live thread when present so
    // we get the thread-scoped history; channel cold starts pass `thread: null`
    // so we get the channel scrollback. The router's contract is oldest-first,
    // which lets us slice [head] + [tail] without re-sorting. We over-request
    // by one (head + tail + 1) so we can detect "exactly head + tail" without
    // emitting a misleading elision marker for a zero-length gap.
    const requested = head + tail + 1
    const result = await fetchHistory(live.key.adapter, {
      chat: live.key.chat,
      thread: live.key.thread,
      limit: requested,
    })

    if (!result.ok) {
      logger.warn(`[channels] ${live.keyId}: prefetch skipped (history fetch failed: ${result.error})`)
      return
    }

    // Drop the engaging message itself if it appears in the history result.
    // Without this, the model would see the same message twice — once in
    // "Recent context" and once in "Current message". Adapters typically
    // return the latest channel/thread messages, so this overlap is the
    // common case, not the edge case.
    const filteredMessages =
      triggeringMessageId !== undefined
        ? result.messages.filter((m) => m.externalMessageId !== triggeringMessageId)
        : result.messages
    if (filteredMessages.length === 0) return

    const seeded = sliceHeadTail(filteredMessages, head, tail)
    const observed: ObservedInbound[] = []
    for (const item of seeded) {
      if (item.kind === 'message') {
        observed.push({
          text: item.message.text,
          authorId: item.message.authorId,
          authorName: item.message.authorName,
          authorIsBot: item.message.isBot,
          receivedAt: now(),
          ts: item.message.ts,
        })
      } else {
        observed.push({
          text: `[… ${item.elidedCount} earlier messages elided; call channel_history for full thread …]`,
          authorId: '__typeclaw_system__',
          authorName: 'TypeClaw',
          authorIsBot: true,
          receivedAt: now(),
          ts: 0,
        })
      }
    }

    if (observed.length === 0) return

    // Cold-start prefetch is one-shot and may exceed CONTEXT_BUFFER_SIZE — the
    // 20-message cap exists to bound *runtime* observation drift, not the
    // initial seed. Subsequent observe() calls will trim back to the cap as
    // normal. We push into contextBuffer (not promptQueue) because these are
    // background context for the model, not turns it must respond to.
    live.contextBuffer.push(...observed)
    logger.info(`[channels] ${live.keyId}: prefetched ${observed.length} context messages`)
  }

  const persistParticipants = async (live: LiveSession): Promise<void> => {
    if (mappings === null) return
    const idx = mappings.findIndex(
      (s) =>
        s.adapter === live.key.adapter &&
        s.workspace === live.key.workspace &&
        s.chat === live.key.chat &&
        (s.thread ?? null) === (live.key.thread ?? null),
    )
    if (idx < 0) return
    const next = mappings.slice()
    next[idx] = { ...next[idx]!, participants: live.participants }
    mappings = next
    await persist()
  }

  const fireTyping = async (live: LiveSession, phase: 'tick' | 'stop'): Promise<void> => {
    const callbacks = typingCallbacks.get(live.key.adapter)
    if (!callbacks || callbacks.size === 0) return
    // Snapshot before iterating: a callback could unregister mid-call.
    const snapshot = Array.from(callbacks)
    const target = {
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      phase,
    }
    await Promise.all(
      snapshot.map((cb) =>
        cb(target).catch((err) => {
          logger.warn(`[channels] typing callback threw for ${live.keyId}: ${describe(err)}`)
        }),
      ),
    )
  }

  const startTypingHeartbeat = (live: LiveSession): void => {
    if (live.typingTimedOut || live.typingStopPromise) return
    if (live.typingTimer || live.destroyed) return
    live.typingStartedAt = now()
    // Fire immediately so the indicator appears on the very first inbound,
    // not 8 seconds later.
    void fireTyping(live, 'tick')
    live.typingTimer = setInterval(() => {
      if (live.destroyed) {
        void stopTypingHeartbeat(live)
        return
      }
      if (now() - live.typingStartedAt >= MAX_TYPING_HEARTBEAT_MS) {
        logger.warn(`[channels] ${live.keyId}: typing heartbeat timed out after ${MAX_TYPING_HEARTBEAT_MS}ms`)
        live.typingTimedOut = true
        void stopTypingHeartbeat(live)
        return
      }
      void fireTyping(live, 'tick')
    }, TYPING_HEARTBEAT_MS)
  }

  const stopTypingHeartbeat = async (live: LiveSession): Promise<void> => {
    if (!live.typingTimer) {
      await live.typingStopPromise
      return
    }
    clearInterval(live.typingTimer)
    live.typingTimer = null
    live.typingStartedAt = 0
    // Fire 'stop' phase even when destroyed: adapters need the chance to
    // clear platform-side state (e.g. Slack's 2-min server timeout) on
    // teardown. The FIFO inside the slack adapter ensures this clear lands
    // AFTER any in-flight 'tick' from the heartbeat that just stopped.
    const stopped = fireTyping(live, 'stop').finally(() => {
      if (live.typingStopPromise === stopped) live.typingStopPromise = null
    })
    live.typingStopPromise = stopped
    await stopped
  }

  const fireSessionIdle = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    const work = live.hooks.runSessionIdle({
      sessionId: live.sessionId,
      parentTranscriptPath: live.getTranscriptPath?.(),
      idleMs: 0,
      origin: buildLiveOrigin(live),
    })
    try {
      await raceWithTimeout(work, sessionIdleTimeoutMs, `[channels] ${live.keyId} session.idle`)
    } catch (err) {
      logger.warn(`[channels] session.idle hook threw for ${live.keyId}: ${describe(err)}`)
    }
  }

  const fireSessionTurnStart = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    try {
      await live.hooks.runSessionTurnStart({
        sessionId: live.sessionId,
        agentDir: options.agentDir,
        origin: buildLiveOrigin(live),
      })
    } catch (err) {
      logger.warn(`[channels] session.turn.start hook threw for ${live.keyId}: ${describe(err)}`)
    }
  }

  const fireSessionTurnEnd = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    try {
      await live.hooks.runSessionTurnEnd({
        sessionId: live.sessionId,
        agentDir: options.agentDir,
        origin: buildLiveOrigin(live),
      })
    } catch (err) {
      logger.warn(`[channels] session.turn.end hook threw for ${live.keyId}: ${describe(err)}`)
    }
  }

  const buildLiveOrigin = (live: LiveSession): SessionOrigin => {
    const membership = readMembership(live.key)
    return {
      kind: 'channel',
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      ...(live.resolvedNames.workspaceName !== undefined ? { workspaceName: live.resolvedNames.workspaceName } : {}),
      chat: live.key.chat,
      ...(live.resolvedNames.chatName !== undefined ? { chatName: live.resolvedNames.chatName } : {}),
      thread: live.key.thread,
      ...(live.currentTurnAuthorId !== null ? { lastInboundAuthorId: live.currentTurnAuthorId } : {}),
      participants: live.participants,
      ...(membership !== null ? { membership } : {}),
    }
  }

  const fireSessionEnd = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    try {
      await live.hooks.runSessionEnd({ sessionId: live.sessionId })
    } catch (err) {
      logger.warn(`[channels] session.end hook threw for ${live.keyId}: ${describe(err)}`)
    }
  }

  const stopCurrentChannelTurn = async (live: LiveSession): Promise<void> => {
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    live.debounceTimer = null
    live.firstUnprocessedAt = 0
    live.promptQueue.length = 0
    live.pendingSystemReminders.length = 0
    await stopTypingHeartbeat(live)
    try {
      await live.session.abort()
      logger.info(`[channels] ${live.keyId}: command /stop aborted current turn`)
    } catch (err) {
      logger.warn(`[channels] ${live.keyId}: command /stop abort failed: ${describe(err)}`)
    }
  }

  const drain = async (live: LiveSession): Promise<void> => {
    if (live.draining || live.destroyed) return
    live.draining = true
    try {
      while ((live.promptQueue.length > 0 || live.pendingSystemReminders.length > 0) && !live.destroyed) {
        live.typingTimedOut = false
        // Heartbeat must run during generation as well as during debounce.
        // Because new inbounds during a turn just push into promptQueue
        // without re-entering route(), the route() call site alone wouldn't
        // keep the indicator alive across multiple drain iterations.
        startTypingHeartbeat(live)
        const batch = live.promptQueue.splice(0, live.promptQueue.length)
        const observed = live.contextBuffer.splice(0, live.contextBuffer.length)
        const reminders = live.pendingSystemReminders.splice(0, live.pendingSystemReminders.length)
        const text = composeTurnPrompt(observed, batch, {
          loopGuardActive: live.loopGuardActive,
          systemReminders: reminders,
        })

        live.currentTurnAuthorId = batch.length > 0 ? batch[batch.length - 1]!.authorId : null
        live.currentTurnAuthorIds = new Set(batch.map((m) => m.authorId))
        if (batch.length > 0) {
          live.consecutiveSends.clear()
          live.lastSentText.clear()
        }

        // Update the live origin holder so this turn's tool.before events
        // carry the current actor's id. The DefaultResourceLoader still
        // renders the session-creation origin into the system prompt (v0.2
        // work to regenerate that per-turn); but permission gating off
        // `lastInboundAuthorId` happens in the tool layer and now sees the
        // live value.
        live.originRef.current = buildLiveOrigin(live)

        // Bracketing logs around the LLM call so a hung prompt() is
        // diagnosable from logs alone (we see prompting without prompted).
        // text length is a proxy for "did we send something at all".
        logger.info(`[channels] ${live.keyId} prompting batch=${batch.length} text_len=${text.length}`)
        const promptStart = now()
        const successfulSendsBeforePrompt = live.successfulChannelSends
        await fireSessionTurnStart(live)
        try {
          await live.session.prompt(text)
          await validateChannelTurn(live, successfulSendsBeforePrompt)
          live.consecutiveAborts = 0
          logger.info(`[channels] ${live.keyId} prompted elapsed_ms=${now() - promptStart}`)
        } catch (err) {
          logger.error(`[channels] ${live.keyId}: prompt threw: ${describe(err)}`)
          live.consecutiveSends.clear()
          live.lastSentText.clear()
        } finally {
          await fireSessionTurnEnd(live)
        }
        await fireSessionIdle(live)
        live.lastTurnAuthorIds = new Set(live.currentTurnAuthorIds)
      }
    } finally {
      live.draining = false
      live.currentTurnAuthorId = null
      live.currentTurnAuthorIds = new Set()
      await stopTypingHeartbeat(live)
    }
  }

  const scheduleDebouncedDrain = (live: LiveSession): void => {
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    const t = now()
    const sinceLast = t - live.lastInboundAt
    const baseWait = sinceLast < HOT_THRESHOLD_MS ? HOT_DEBOUNCE_MS : INITIAL_DEBOUNCE_MS
    if (live.firstUnprocessedAt === 0) live.firstUnprocessedAt = t
    const elapsedSinceFirst = t - live.firstUnprocessedAt
    const wait = Math.max(0, Math.min(baseWait, MAX_DEBOUNCE_MS - elapsedSinceFirst))
    live.lastInboundAt = t
    if (mappings) {
      const idx = mappings.findIndex(
        (s) =>
          s.adapter === live.key.adapter &&
          s.workspace === live.key.workspace &&
          s.chat === live.key.chat &&
          (s.thread ?? null) === (live.key.thread ?? null),
      )
      if (idx >= 0) {
        mappings[idx] = { ...mappings[idx]!, lastInboundAt: t }
        void persist()
      }
    }
    live.debounceTimer = setTimeout(() => {
      live.debounceTimer = null
      live.firstUnprocessedAt = 0
      void drain(live)
    }, wait)
  }

  const route = async (event: InboundMessage): Promise<void> => {
    const adapterConfig = options.configForAdapter(event.adapter)
    if (!adapterConfig) return

    const key: ChannelKey = {
      adapter: event.adapter,
      workspace: event.workspace,
      chat: event.chat,
      thread: event.thread,
    }

    // Role-claim intercept runs BEFORE the channel.respond gate so the
    // operator can bootstrap permissions on a fresh agent that has no
    // role match rules yet. Cheap pre-check: only DMs whose text contains
    // a `claim-` prefix can be claim attempts, and only when a handler
    // is registered. Everything else falls straight through to the gate.
    if (claimHandler !== undefined && event.isDm && extractClaimCode(event.text) !== null) {
      const outcome = await claimHandler({
        adapter: event.adapter,
        workspace: event.workspace,
        chat: event.chat,
        isDm: event.isDm,
        authorId: event.authorId,
        text: event.text,
      })
      if (outcome.kind !== 'fallthrough') {
        logger.info(
          `[channels] ${channelKeyId(key)}: claim ${outcome.kind} author=${event.authorId} id=${event.externalMessageId}`,
        )
        await send(
          {
            adapter: event.adapter,
            workspace: event.workspace,
            chat: event.chat,
            thread: event.thread,
            text: outcome.reply,
          },
          { source: 'system' },
        )
        return
      }
    }

    if (isChannelRespondDenied(event)) {
      logger.info(
        `[channels] ${channelKeyId(key)}: denied by permissions (channel.respond) author=${event.authorId} id=${event.externalMessageId}`,
      )
      return
    }

    const parsedCommand = commands.parse(event.text)
    if (parsedCommand !== null) {
      // Commands are control traffic, not engaged inbounds; if the session is stale,
      // the next engaged inbound will perform the rollover before prompting.
      const keyId = channelKeyId(key)
      if (!commands.has(parsedCommand.name)) {
        logger.info(`[channels] ${keyId}: ignoring unknown command /${parsedCommand.name}`)
        return
      }
      const existingLive = liveSessions.get(keyId)
      if (!existingLive || existingLive.destroyed) {
        logger.info(`[channels] ${keyId}: ignoring command /${parsedCommand.name} with no live session`)
        return
      }
      const commandResult = await commands.execute(event.text, { live: existingLive, event })
      if (commandResult.kind !== 'not-command') return
    }

    const live = await ensureLive(key, event.externalMessageId, event.authorId)

    const isNewAuthor = !live.participants.some((p) => p.authorId === event.authorId)
    live.participants = updateParticipants(
      live.participants,
      event.authorId,
      event.authorName,
      now(),
      event.authorIsBot,
    )
    void persistParticipants(live)

    // A previously-unseen author just spoke. The cached membership count
    // (from /members or history-derived) was computed without them, so
    // invalidate and warm in the background. We don't await — the warmup
    // runs alongside this turn's `membershipForEngagement` call so the
    // *next* turn sees fresh data, but the current turn still gets a
    // fast answer (cache miss → cold fetch with timeout, or stale-ok).
    if (isNewAuthor && live.key.workspace !== '@dm') {
      const cache = membershipCaches.get(live.key.adapter)
      if (cache !== undefined) {
        cache.invalidate(live.key)
        void cache.warmUp(live.key).catch((err) => {
          logger.warn(`[channels] membership warmup after new author failed for ${live.keyId}: ${describe(err)}`)
        })
      }
    }

    const membership = await membershipForEngagement(live)

    const decision: EngagementDecision = decideEngagement({
      message: event,
      config: adapterConfig.engagement,
      key: live.keyId,
      ledger: stickyLedger,
      now: now(),
      participants: live.participants,
      membership,
      selfAliases: computeSelfAliases(),
      botInThread: hasBotParticipated(live),
    })

    if (decision === 'observe') {
      // Log every observe so an unanswered mention is diagnosable from logs
      // alone instead of "routed but no prompting" silence. The bracketed
      // shape mirrors `prompting batch=` so log scraping can pair them.
      logger.info(`[channels] ${live.keyId} observed id=${event.externalMessageId}`)
      observe(live, event)
      return
    }

    updateLoopGuard(live, event)

    enqueue(live, event)

    // Start showing "typing..." the moment we know we're going to engage,
    // so users see the indicator during the debounce window — not just
    // during LLM generation. drain() will keep it alive across iterations
    // and the finally-block will stop it when the queue empties.
    startTypingHeartbeat(live)

    if (live.draining) {
      // In-flight turn; let coalesce-on-drain pick it up. Same-author abort
      // is a v0.2 enhancement once we have safe abort semantics through
      // pi-coding-agent for in-flight tool calls.
      return
    }
    scheduleDebouncedDrain(live)
  }

  const isChannelRespondDenied = (event: InboundMessage): boolean => {
    const partial: SessionOrigin = {
      kind: 'channel',
      adapter: event.adapter,
      workspace: event.workspace,
      chat: event.chat,
      thread: event.thread,
      lastInboundAuthorId: event.authorId,
    }
    return !permissions.has(partial, CORE_PERMISSIONS.channelRespond)
  }

  const updateLoopGuard = (live: LiveSession, event: InboundMessage): void => {
    if (!event.authorIsBot) {
      live.recentEngagedPeerBotTurns.length = 0
      live.consecutiveEngagedPeerBotTurns = 0
      live.loopGuardActive = false
      return
    }
    const t = now()
    live.consecutiveEngagedPeerBotTurns++
    live.recentEngagedPeerBotTurns.push({ authorId: event.authorId, ts: t })
    const cutoff = t - PEER_BOT_TURNS_WINDOW_MS
    while (live.recentEngagedPeerBotTurns.length > 0 && live.recentEngagedPeerBotTurns[0]!.ts < cutoff) {
      live.recentEngagedPeerBotTurns.shift()
    }
    if (
      live.consecutiveEngagedPeerBotTurns >= MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN ||
      live.recentEngagedPeerBotTurns.length >= MAX_PEER_BOT_TURNS_IN_WINDOW
    ) {
      live.loopGuardActive = true
    }
  }

  const hasBotParticipated = (live: LiveSession): boolean => {
    if (live.successfulChannelSends > 0) return true
    for (const item of live.contextBuffer) {
      if (item.authorIsBot) return true
    }
    return false
  }

  const observe = (live: LiveSession, event: InboundMessage): void => {
    live.contextBuffer.push({
      text: event.text,
      authorId: event.authorId,
      authorName: event.authorName,
      authorIsBot: event.authorIsBot,
      receivedAt: now(),
      ts: event.ts,
    })
    if (live.contextBuffer.length > CONTEXT_BUFFER_SIZE) {
      live.contextBuffer.splice(0, live.contextBuffer.length - CONTEXT_BUFFER_SIZE)
    }
  }

  const enqueue = (live: LiveSession, event: InboundMessage): void => {
    live.promptQueue.push({
      text: event.text,
      authorId: event.authorId,
      authorName: event.authorName,
      authorIsBot: event.authorIsBot,
      externalMessageId: event.externalMessageId,
      isBotMention: event.isBotMention,
      replyToBotMessageId: event.replyToBotMessageId,
      isDm: event.isDm,
      receivedAt: now(),
      ts: event.ts,
    })
  }

  const registerOutbound = (adapter: ChannelKey['adapter'], cb: OutboundCallback): void => {
    let set = outboundCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      outboundCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterOutbound = (adapter: ChannelKey['adapter'], cb: OutboundCallback): void => {
    outboundCallbacks.get(adapter)?.delete(cb)
  }

  const registerTyping = (adapter: ChannelKey['adapter'], cb: TypingCallback): void => {
    let set = typingCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      typingCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterTyping = (adapter: ChannelKey['adapter'], cb: TypingCallback): void => {
    typingCallbacks.get(adapter)?.delete(cb)
  }

  const registerChannelNameResolver = (adapter: ChannelKey['adapter'], resolver: ChannelNameResolver): void => {
    let set = channelNameResolvers.get(adapter)
    if (!set) {
      set = new Set()
      channelNameResolvers.set(adapter, set)
    }
    set.add(resolver)
  }

  const unregisterChannelNameResolver = (adapter: ChannelKey['adapter'], resolver: ChannelNameResolver): void => {
    channelNameResolvers.get(adapter)?.delete(resolver)
  }

  const registerMembership = (adapter: ChannelKey['adapter'], resolver: MembershipResolver): void => {
    let set = membershipResolvers.get(adapter)
    if (!set) {
      set = new Set()
      membershipResolvers.set(adapter, set)
    }
    set.add(resolver)
    if (!membershipCaches.has(adapter)) {
      membershipCaches.set(
        adapter,
        createMembershipCache({ resolver: resolveThroughRegisteredMembership, now, logger }),
      )
    }
  }

  const unregisterMembership = (adapter: ChannelKey['adapter'], resolver: MembershipResolver): void => {
    membershipResolvers.get(adapter)?.delete(resolver)
    if ((membershipResolvers.get(adapter)?.size ?? 0) === 0) {
      membershipCaches.delete(adapter)
    }
  }

  const registerHistory = (adapter: ChannelKey['adapter'], cb: HistoryCallback): void => {
    let set = historyCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      historyCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterHistory = (adapter: ChannelKey['adapter'], cb: HistoryCallback): void => {
    historyCallbacks.get(adapter)?.delete(cb)
  }

  const fetchHistory = async (adapter: ChannelKey['adapter'], args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const callbacks = historyCallbacks.get(adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: 'history-not-supported' }
    }
    // Snapshot before iterating, mirroring `send`: a callback that mutates
    // the set (e.g. unregisters mid-call) must not skip siblings.
    const snapshot = Array.from(callbacks)
    let lastError: FetchHistoryResult & { ok: false } = { ok: false, error: 'history-not-supported' }
    for (const cb of snapshot) {
      try {
        const result = await raceWithTimeout(cb(args), fetchHistoryTimeoutMs, `[channels] ${adapter} history fetch`)
        if (result.ok) return result
        lastError = result
      } catch (err) {
        logger.warn(`[channels] history fetch threw for ${adapter}: ${describe(err)}`)
        lastError = { ok: false, error: 'history-not-supported' }
      }
    }
    return lastError
  }

  const registerFetchAttachment = (adapter: ChannelKey['adapter'], cb: FetchAttachmentCallback): void => {
    let set = fetchAttachmentCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      fetchAttachmentCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterFetchAttachment = (adapter: ChannelKey['adapter'], cb: FetchAttachmentCallback): void => {
    fetchAttachmentCallbacks.get(adapter)?.delete(cb)
  }

  const fetchAttachment = async (
    adapter: ChannelKey['adapter'],
    args: FetchAttachmentArgs,
  ): Promise<FetchAttachmentResult> => {
    const callbacks = fetchAttachmentCallbacks.get(adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `no fetchAttachment callback registered for "${adapter}"` }
    }
    const snapshot = Array.from(callbacks)
    // Initialized only so TypeScript can prove the variable is assigned
    // before return. The loop body always overwrites it on the failure
    // path (we just returned on the success path), so this string is
    // unreachable at runtime — kept as a clearly-tagged sentinel rather
    // than a non-null assertion so a future loop refactor that breaks
    // this invariant surfaces a recognizable error string.
    let lastError: FetchAttachmentResult & { ok: false } = {
      ok: false,
      error: `fetchAttachment for "${adapter}" returned no result (router bug)`,
    }
    for (const cb of snapshot) {
      const result = await cb(args)
      if (result.ok) return result
      lastError = result
    }
    return lastError
  }

  const send = async (msg: OutboundMessage, opts?: SendOptions): Promise<SendResult> => {
    const source: SendSource = opts?.source ?? 'tool'
    const callbacks = outboundCallbacks.get(msg.adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `no adapter registered for "${msg.adapter}"`, code: 'no-adapter' }
    }

    const keyId = channelKeyId({
      adapter: msg.adapter,
      workspace: msg.workspace,
      chat: msg.chat,
      thread: msg.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    const sendKey = consecutiveSendKey(msg.chat, msg.thread)
    const text = normalizeSendText(msg.text)

    // Central enforcement. Tool-initiated sends are subject to two policies:
    // a per-turn count cap (kills runaway loops regardless of content) and
    // an exact-duplicate guard (kills the byte-identical-spam sub-mode).
    // Both checks AND the state mutations they consult happen synchronously
    // before any `await`, so two concurrent `router.send` calls for the same
    // target (the parallel-tool-execution race) cannot both pass: the
    // second observer sees the first one's increment / lastSentText write.
    // System sources (validateChannelTurn recovery, role-claim reply) bypass
    // — those are one-shot paths the policy doesn't apply to.
    let priorLastSentText: string | undefined
    let reserved = false
    if (live && source === 'tool') {
      const currentCount = live.consecutiveSends.get(sendKey) ?? 0
      if (currentCount >= MAX_CHANNEL_SENDS_PER_TURN) {
        return { ok: false, error: TURN_CAP_ERROR, code: 'turn-cap' }
      }
      if (text !== undefined && live.lastSentText.get(sendKey) === text) {
        return { ok: false, error: DUPLICATE_SEND_ERROR, code: 'duplicate' }
      }
      // Reserve the slot before awaiting. If the callback rejects we roll
      // back below; if it succeeds we keep the increment. The slot reserve
      // is what makes parallel tool calls safe. We also snapshot the prior
      // lastSentText so a transient delivery failure can be retried with
      // the same text — the dup-guard exists to stop runaway loops, not to
      // strand the model on a flaky adapter.
      priorLastSentText = live.lastSentText.get(sendKey)
      live.consecutiveSends.set(sendKey, currentCount + 1)
      if (text !== undefined) live.lastSentText.set(sendKey, text)
      reserved = true
    }

    // Snapshot the callbacks before iterating so a callback that mutates the
    // set (e.g. unregisters mid-send) does not cause the iterator to skip
    // siblings or trip into surprising behavior.
    const snapshot = Array.from(callbacks)
    let lastError: string | undefined
    let delivered = false
    for (const cb of snapshot) {
      const result = await cb(msg)
      if (result.ok) {
        delivered = true
        break
      }
      lastError = result.error
    }

    if (!delivered) {
      // Roll back the slot reservation so a failed send doesn't burn cap
      // budget or poison the dup-guard. Restoring lastSentText to its
      // prior value (which may be undefined) lets a legitimate retry of
      // the same text succeed — the dup-guard is for loops, not flake.
      if (live && reserved) {
        const after = (live.consecutiveSends.get(sendKey) ?? 1) - 1
        if (after <= 0) live.consecutiveSends.delete(sendKey)
        else live.consecutiveSends.set(sendKey, after)
        if (priorLastSentText === undefined) live.lastSentText.delete(sendKey)
        else live.lastSentText.set(sendKey, priorLastSentText)
      }
      return { ok: false, error: lastError ?? 'no callback accepted the outbound', code: 'callback-rejected' }
    }

    if (live) {
      live.successfulChannelSends++
      // Don't stop the heartbeat here: the agent may still be mid-turn and
      // about to send another reply. drain()'s finally block owns turn-end
      // stop. But Slack's adapter outbound callback explicitly clears
      // platform-side typing after every successful postMessage (to defeat
      // the heartbeat-vs-postMessage race fixed in PR #52), so a fresh
      // 'tick' must land in the FIFO right after that clear — otherwise
      // the indicator stays cleared until the next 8s interval, leaving a
      // visible idle gap between mid-turn sends on Slack. The await on
      // cb(msg) above already drained the outbound callback's clearAfterSend
      // through the per-(chat,thread) FIFO, so this tick is guaranteed to
      // land after it. Discord and Telegram treat the extra tick as a
      // no-op refresh of their already-armed (auto-expiring) indicators.
      if (live.typingTimer) void fireTyping(live, 'tick')
      const adapterConfig = options.configForAdapter(msg.adapter)
      if (adapterConfig) {
        const targetIds = Array.from(
          live.currentTurnAuthorIds.size > 0 ? live.currentTurnAuthorIds : live.lastTurnAuthorIds,
        )
        if (targetIds.length > 0) {
          grantStickyForReplyTargets(stickyLedger, keyId, targetIds, adapterConfig.engagement, now())
        }
      }
      const turnCount = live.consecutiveSends.get(sendKey) ?? 0
      const rateCount = recordSendTimestamp(live, sendKey, now())
      const level = rateCount >= SEND_RATE_WARN_THRESHOLD ? 'warn' : 'info'
      const warn = rateCount >= SEND_RATE_WARN_THRESHOLD ? ' send_rate_warning' : ''
      const textLen = text !== undefined ? text.length : 0
      const fields = `source=${source} turn=${turnCount} rate=${rateCount}/${SEND_RATE_WINDOW_MS}ms text_len=${textLen}`
      logger[level](`[channels] ${live.keyId} send ${fields}${warn}`)
    }

    return { ok: true }
  }

  const validateChannelTurn = async (live: LiveSession, successfulSendsBeforePrompt: number): Promise<void> => {
    if (live.successfulChannelSends > successfulSendsBeforePrompt) return

    const assistantText = latestAssistantText(live.session)
    if (assistantText === null) return

    if (isNoReplySignal(assistantText)) {
      logger.info(`[channels] ${live.keyId} no_reply`)
      return
    }

    if (isUpstreamEmptyResponseSentinel(assistantText)) {
      logger.warn(
        `[channels] ${live.keyId}: suppressed upstream_empty_response_sentinel text_len=${assistantText.length}`,
      )
      return
    }

    logger.warn(
      `[channels] ${live.keyId}: recovering assistant_text_without_channel_tool text_len=${assistantText.length}`,
    )
    const result = await send(
      {
        adapter: live.key.adapter,
        workspace: live.key.workspace,
        chat: live.key.chat,
        thread: live.key.thread,
        text: assistantText,
      },
      { source: 'system' },
    )
    if (!result.ok) {
      logger.warn(`[channels] ${live.keyId}: recovery send failed: ${result.error}`)
    }
  }

  const getConsecutiveSendCount = (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }): number => {
    const keyId = channelKeyId({
      adapter: target.adapter,
      workspace: target.workspace,
      chat: target.chat,
      thread: target.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    if (!live) return 0
    return live.consecutiveSends.get(consecutiveSendKey(target.chat, target.thread)) ?? 0
  }

  const getSendRate = (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }): { count: number; windowMs: number } => {
    const keyId = channelKeyId({
      adapter: target.adapter,
      workspace: target.workspace,
      chat: target.chat,
      thread: target.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    if (!live) return { count: 0, windowMs: SEND_RATE_WINDOW_MS }
    const sendKey = consecutiveSendKey(target.chat, target.thread)
    const buf = live.sendTimestamps.get(sendKey)
    if (!buf || buf.length === 0) return { count: 0, windowMs: SEND_RATE_WINDOW_MS }
    const cutoff = now() - SEND_RATE_WINDOW_MS
    let i = 0
    while (i < buf.length && buf[i]! <= cutoff) i++
    if (i > 0) buf.splice(0, i)
    return { count: buf.length, windowMs: SEND_RATE_WINDOW_MS }
  }

  const tearDownLive = async (live: LiveSession): Promise<void> => {
    live.destroyed = true
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    live.debounceTimer = null
    live.unsubProviderErrors?.()
    live.unsubProviderErrors = null
    await stopTypingHeartbeat(live)
    try {
      await live.session.abort()
    } catch (err) {
      logger.warn(`[channels] abort failed for ${live.keyId}: ${describe(err)}`)
    }
    await fireSessionEnd(live)
    try {
      await live.dispose()
    } catch (err) {
      logger.warn(`[channels] dispose failed for ${live.keyId}: ${describe(err)}`)
    }
  }

  const runIdleGc = async (): Promise<void> => {
    const t = now()
    const victims: LiveSession[] = []
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.draining) continue
      if (live.promptQueue.length > 0) continue
      if (t - live.lastInboundAt <= SESSION_IDLE_MS) continue
      victims.push(live)
    }
    for (const live of victims) {
      liveSessions.delete(live.keyId)
      logger.info(`[channels] ${live.keyId} idle_gc evicting after ${t - live.lastInboundAt}ms idle`)
      await tearDownLive(live)
    }
  }

  let gcTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void runIdleGc()
  }, SESSION_GC_INTERVAL_MS)
  // Don't keep the Bun process alive just for the GC tick; the host
  // server's WebSocket listener owns process lifetime.
  gcTimer.unref?.()

  const stop = async (): Promise<void> => {
    if (gcTimer) clearInterval(gcTimer)
    gcTimer = null
    const all = Array.from(liveSessions.values())
    liveSessions.clear()
    for (const live of all) {
      await tearDownLive(live)
    }
  }

  const executeCommand = async (
    key: ChannelKey,
    name: string,
    options: ExecuteCommandOptions,
  ): Promise<ExecuteCommandResult> => {
    const lowered = name.toLowerCase()
    if (!commands.has(lowered)) {
      return { kind: 'unknown-command', name: lowered }
    }
    // Permission gate runs BEFORE the live-session lookup so a guest user
    // invoking /stop on a non-existent session gets 'permission-denied'
    // (consistent answer regardless of session state) rather than leaking
    // session presence via the 'no-live-session' vs 'permission-denied'
    // distinction.
    const partial: SessionOrigin = {
      kind: 'channel',
      adapter: key.adapter,
      workspace: key.workspace,
      chat: key.chat,
      thread: key.thread,
      lastInboundAuthorId: options.invokerId,
    }
    if (!permissions.has(partial, CORE_PERMISSIONS.channelRespond)) {
      return { kind: 'permission-denied' }
    }
    const resolved = resolveLiveSessionForCommand(liveSessions, key)
    if (resolved.kind === 'none') {
      return { kind: 'no-live-session' }
    }
    if (resolved.kind === 'ambiguous') {
      return { kind: 'ambiguous', matchCount: resolved.count }
    }
    const result = await commands.execute(`/${lowered}`, { live: resolved.session, event: null })
    if (result.kind === 'handled') {
      return { kind: 'handled', name: result.name }
    }
    // commands.execute can only return not-command (impossible — we pass a
    // leading slash), unknown-command (impossible — we just checked has()),
    // or handled. Any other outcome is a bug.
    return { kind: 'unknown-command', name: lowered }
  }

  const injectSubagentCompletionReminder = (args: {
    parentSessionId: string
    subagent: string
    taskId: string
    ok: boolean
    durationMs: number
    error?: string
  }): { kind: 'delivered'; keyId: string } | { kind: 'no-live-session' } => {
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.sessionId !== args.parentSessionId) continue
      const text = renderSubagentCompletionReminder({
        subagent: args.subagent,
        taskId: args.taskId,
        ok: args.ok,
        durationMs: args.durationMs,
        ...(args.error !== undefined ? { error: args.error } : {}),
        channel: true,
      })
      live.pendingSystemReminders.push(text)
      logger.info(`[channels] ${live.keyId}: subagent-completion reminder queued task=${args.taskId} ok=${args.ok}`)
      // Wake the drain loop. If a turn is already in flight, the wakeup is
      // a no-op because drain() will pick up the reminder on its next
      // iteration (it now gates on promptQueue OR pendingSystemReminders).
      // If the session is idle, fire drain() immediately rather than going
      // through the debounce path — the reminder is not a user inbound,
      // so the "coalesce nearby inbounds" rationale for debouncing does
      // not apply. Mirrors the TUI path's `idle ? 'interrupt' : 'queue'`
      // semantics: the channel router doesn't have a `delivery: interrupt`
      // mechanism (no in-flight abort during a turn), but firing drain()
      // immediately is the equivalent for an idle session.
      if (!live.draining) {
        void drain(live)
      }
      return { kind: 'delivered', keyId: live.keyId }
    }
    return { kind: 'no-live-session' }
  }

  return {
    route,
    send,
    getConsecutiveSendCount,
    getSendRate,
    registerOutbound,
    unregisterOutbound,
    registerTyping,
    unregisterTyping,
    registerChannelNameResolver,
    unregisterChannelNameResolver,
    registerMembership,
    unregisterMembership,
    registerHistory,
    unregisterHistory,
    fetchHistory,
    registerFetchAttachment,
    unregisterFetchAttachment,
    fetchAttachment,
    executeCommand,
    getSelfAliases: computeSelfAliases,
    injectSubagentCompletionReminder,
    stop,
    liveCount: () => liveSessions.size,
    __testing: {
      flushDebounce: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        if (live.debounceTimer) {
          clearTimeout(live.debounceTimer)
          live.debounceTimer = null
        }
        live.firstUnprocessedAt = 0
        await drain(live)
      },
      fireTypingHeartbeat: async (key: ChannelKey, phase: 'tick' | 'stop' = 'tick') => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        await fireTyping(live, phase)
      },
      fireTypingInterval: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live || !live.typingTimer) return
        if (live.destroyed) {
          await stopTypingHeartbeat(live)
          return
        }
        if (now() - live.typingStartedAt >= MAX_TYPING_HEARTBEAT_MS) {
          logger.warn(`[channels] ${live.keyId}: typing heartbeat timed out after ${MAX_TYPING_HEARTBEAT_MS}ms`)
          live.typingTimedOut = true
          await stopTypingHeartbeat(live)
          return
        }
        await fireTyping(live, 'tick')
      },
      isTypingActive: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        return live?.typingTimer !== null && live?.typingTimer !== undefined
      },
      stopTyping: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        await stopTypingHeartbeat(live)
      },
      runIdleGc,
    },
  }
}

function composeTurnPrompt(
  observed: readonly ObservedInbound[],
  batch: readonly QueuedInbound[],
  state: { loopGuardActive: boolean; systemReminders?: readonly string[] } = { loopGuardActive: false },
): string {
  const parts: string[] = []
  // System reminders (subagent-completion wakeups today) lead the turn body
  // because they are typically what triggered the drain — when the prompt
  // queue is empty and the only thing in this iteration is a reminder, the
  // model needs to see the reminder before any optional context. The
  // reminder block is self-fenced by its <system-reminder> tags, so no
  // extra framing is needed and the model already learns this shape from
  // the TUI path; channel sessions see the same tags.
  if (state.systemReminders && state.systemReminders.length > 0) {
    for (const reminder of state.systemReminders) {
      parts.push(reminder)
    }
    parts.push('')
  }
  // Loop-guard notice lives in the user-turn text (recomposed every drain)
  // rather than in the system prompt so it does not invalidate the
  // prompt-prefix cache. The cached prefix covers system + tools + earlier
  // turns; the current user-turn suffix is non-cacheable by design, so
  // adding a section here is cache-neutral.
  //
  // SYSTEM MESSAGE convention: any runtime-injected block in the user turn
  // that is NOT from a chat participant must use the
  // `**[SYSTEM MESSAGE — not from a human]**` framing fenced by horizontal
  // rules (`---`). This is structurally distinct from the H2 sections used
  // for actual conversation content (`## Recent context`,
  // `## Current message`). Without the fencing, models — especially
  // persona-rich ones like Kimi — read the heading as a human-authored
  // instruction and reply to it ("알겠습니다, 대화 여기까지 할게요"). The
  // bracketed marker plus the explicit "Do not acknowledge or reply to this
  // notice" line is the trust boundary that prevents this. New runtime
  // notices (rate-limit, schema-mismatch, abort signals, etc.) MUST follow
  // this same convention so models learn the pattern.
  if (state.loopGuardActive) {
    parts.push(
      '---',
      '**[SYSTEM MESSAGE — not from a human]**',
      '',
      `The TypeClaw runtime detected that peer bots have engaged you ${MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN}+ times in`,
      `a row without any human input (or ${MAX_PEER_BOT_TURNS_IN_WINDOW}+ times in the last ${PEER_BOT_TURNS_WINDOW_MS / 1000}s). This message`,
      'is an automated signal from the channel router, not a message from anyone',
      'in the chat. **Do not acknowledge or reply to this notice.**',
      '',
      'Guidance:',
      '- If the current message clearly needs a reply, send one and ignore this notice.',
      '- If continuing would add noise, reply with `NO_REPLY` to stay silent this turn.',
      '',
      'This notice clears automatically once a human posts again.',
      '',
      '---',
      '',
    )
  }
  if (observed.length > 0) {
    parts.push('## Recent context (not addressed to you, for awareness only)')
    for (const o of observed) {
      parts.push(formatAuthorLine(o.ts, o.authorId, o.authorName, o.authorIsBot, o.text))
    }
    parts.push('')
    parts.push(batch.length === 1 ? '## Current message (addressed to you)' : '## Current messages (addressed to you)')
  }
  for (const b of batch) {
    parts.push(formatAuthorLine(b.ts, b.authorId, b.authorName, b.authorIsBot, b.text))
  }
  return parts.join('\n')
}

function formatAuthorLine(
  ts: number,
  authorId: string,
  authorName: string,
  authorIsBot: boolean,
  text: string,
): string {
  const tag = authorIsBot ? ' [bot]' : ''
  const stamp = ts > 0 ? `[${new Date(ts).toISOString()}] ` : ''
  return `${stamp}<@${authorId}> (${authorName})${tag}: ${text}`
}

type Sliced = { kind: 'message'; message: ChannelHistoryMessage } | { kind: 'elision'; elidedCount: number }

export function sliceHeadTail(messages: readonly ChannelHistoryMessage[], head: number, tail: number): Sliced[] {
  if (head < 0 || tail < 0) throw new Error(`sliceHeadTail: head and tail must be non-negative (got ${head}, ${tail})`)
  if (head === 0 && tail === 0) return []
  if (messages.length <= head + tail) {
    return messages.map((m) => ({ kind: 'message', message: m }))
  }
  const headSlice: Sliced[] = head > 0 ? messages.slice(0, head).map((m) => ({ kind: 'message', message: m })) : []
  const tailSlice: Sliced[] = tail > 0 ? messages.slice(-tail).map((m) => ({ kind: 'message', message: m })) : []
  const elidedCount = messages.length - head - tail
  return [...headSlice, { kind: 'elision', elidedCount }, ...tailSlice]
}

function tryOpenSessionManager(
  agentDir: string,
  sessionDir: string,
  existingSessionId: string,
  existingSessionFile: string | undefined,
  logger: RouterLogger,
): SessionManager {
  if (existingSessionFile === undefined) {
    logger.warn(
      `[channels] session ${existingSessionId} has no sessionFile (v2 mapping not yet migrated); creating new`,
    )
    return SessionManager.create(agentDir, sessionDir)
  }
  try {
    const path = `${sessionDir}/${existingSessionFile}`
    return SessionManager.open(path)
  } catch (err) {
    logger.warn(
      `[channels] could not rehydrate session ${existingSessionId} from ${existingSessionFile}: ${describe(err)}; creating new`,
    )
    return SessionManager.create(agentDir, sessionDir)
  }
}

function consecutiveSendKey(chat: string, thread: string | null | undefined): string {
  return `${chat}:${thread ?? ''}`
}

export type ResolveLiveSessionResult =
  | { kind: 'found'; session: LiveSession }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

// Lookup policy for adapter-driven commands. Exact-key match always wins.
// On miss, fall back to (adapter, workspace, chat) without thread — but
// only when EXACTLY ONE non-destroyed candidate exists. Ambiguous matches
// return 'ambiguous' so the caller can refuse to act rather than abort an
// arbitrary session.
//
// Why the fallback: Slack slash commands carry channel_id but no thread_ts,
// so a slash invocation from a thread-keyed live session would otherwise
// report no-live-session. Discord doesn't hit this — Discord treats threads
// as channels, so the exact-key path already resolves.
//
// Why ambiguity-rejection: "first match wins" map-iteration semantics would
// abort an arbitrary thread when multiple thread-keyed sessions coexist in
// one channel (plausible on Slack: bot mentioned in multiple threads). The
// user's slash command picker doesn't know about threads; we don't know
// which they meant; refusing is safer than guessing.
export function resolveLiveSessionForCommand(
  liveSessions: ReadonlyMap<string, LiveSession>,
  key: ChannelKey,
): ResolveLiveSessionResult {
  const exact = liveSessions.get(channelKeyId(key))
  if (exact && !exact.destroyed) return { kind: 'found', session: exact }

  const matches: LiveSession[] = []
  for (const candidate of liveSessions.values()) {
    if (candidate.destroyed) continue
    if (
      candidate.key.adapter === key.adapter &&
      candidate.key.workspace === key.workspace &&
      candidate.key.chat === key.chat
    ) {
      matches.push(candidate)
      if (matches.length > 1) {
        return { kind: 'ambiguous', count: matches.length }
      }
    }
  }
  if (matches.length === 1) return { kind: 'found', session: matches[0]! }
  return { kind: 'none' }
}

function normalizeSendText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  if (text === '') return undefined
  return text
}

function recordSendTimestamp(live: LiveSession, sendKey: string, ts: number): number {
  const buf = live.sendTimestamps.get(sendKey)
  const cutoff = ts - SEND_RATE_WINDOW_MS
  if (!buf) {
    live.sendTimestamps.set(sendKey, [ts])
    return 1
  }
  let i = 0
  while (i < buf.length && buf[i]! <= cutoff) i++
  if (i > 0) buf.splice(0, i)
  buf.push(ts)
  return buf.length
}

function dmMembership(fetchedAt: number): MembershipCount {
  return { humans: 1, bots: 1, fetchedAt, truncated: false }
}

async function withMembershipTimeout(
  promise: Promise<MembershipCount | null>,
  key: ChannelKey,
  logger: RouterLogger,
): Promise<MembershipCount | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        `[channels] ${channelKeyId(key)}: membership cold fetch timed out after ${MEMBERSHIP_COLD_FETCH_TIMEOUT_MS}ms`,
      )
      resolve(null)
    }, MEMBERSHIP_COLD_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// Throwing variant of the membership timeout pattern: races the work against
// a deadline and rejects with a descriptive error on miss. Used wherever a
// hung registered callback (Discord/Slack/Telegram REST) would otherwise
// leave an awaiting caller stuck forever and there is no graceful-
// degradation value the caller could substitute (contrast withMembershipTimeout,
// which returns null because engagement can run on a stale membership reading).
// The helper owns timer lifetime so callers cannot leak timers on a fast
// resolution.
async function raceWithTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function latestAssistantText(session: AgentSession): string | null {
  const entry = session.sessionManager.getLeafEntry()
  if (entry?.type !== 'message') return null
  if (entry.message.role !== 'assistant') return null
  if (entry.message.stopReason !== 'stop') return null
  return visibleAssistantText(entry.message)
}

function visibleAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

// Lenient on purpose: distilled / smaller models routinely drift off the
// documented `NO_REPLY` form. We additionally accept `(NO_REPLY)` (Claude-style
// hedging) and empty visible text (e.g. Kimi-distilled models that emit only a
// thinking block and end the turn) — without the empty case we'd recover an
// empty string into the chat. The prompt contract still teaches the strict
// literal; this just widens what we accept. Shared with channel_send /
// channel_reply so all three call sites stay in lockstep.
export function isNoReplySignal(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (trimmed === 'NO_REPLY') return true
  if (trimmed === '(NO_REPLY)') return true
  return false
}

// Detects the upstream "empty response" debug sentinel: when the LLM ends a
// turn with only a `thinking` block, some provider SDK paths (observed
// against claude-opus-4-5 via pi-ai) fabricate a single text block whose
// body is a Python-repr dump of the raw API response — including the
// model's thinking content and Anthropic's tamper-proof signature. The
// recovery path in validateChannelTurn would otherwise post that sentinel
// straight to the channel (production: signature leaked into a public
// Slack channel on 2026-05-21).
//
// Kept separate from isNoReplySignal on purpose: that helper is the agent's
// deliberate silent-turn protocol, this is upstream damage control. They
// log under distinct subjects (`upstream_empty_response_sentinel` vs
// `no_reply`) so an operator can tell a healthy quiet turn from a stream of
// upstream empties that warrant investigation.
//
// Strict detection: leading `(Empty response:` AND a dict-encoded
// `'stop_reason'` key. Catches the observed shape
// `(Empty response: {'content': [...], 'stop_reason': 'end_turn', ...})`
// while allowing legit prose like "Empty response from the cache layer".
export function isUpstreamEmptyResponseSentinel(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('(Empty response:')) return false
  return trimmed.includes("'stop_reason'")
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Used by tests / external diagnostics.
export type { ChannelSessionRecord }
export { channelsSessionsPath }
