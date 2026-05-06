import { basename } from 'node:path'

import type { AssistantMessage } from '@mariozechner/pi-ai'
import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession, type AgentSession } from '@/agent'
import type { ChannelParticipant, SessionOrigin } from '@/agent/session-origin'
import { createCommandRegistry } from '@/commands'
import type { HookBus } from '@/plugin'

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

// Idle GC: a LiveSession whose `lastInboundAt` is older than
// SESSION_IDLE_MS gets evicted on the next GC tick. Persistence
// (channels/sessions.json) is intentionally untouched — the next inbound
// rehydrates from disk against the same sessionId, so the on-disk
// transcript continues across the eviction. The point is to free memory
// (LiveSession holds an open SessionManager + transcript in RAM) and to
// give the next conversation a fresh start without forcing the user to
// notice anything. `lastInboundAt` is bumped only by *engaged* inbounds
// (see scheduleDebouncedDrain), so passive observation alone won't keep
// a session warm forever — that's intentional.
export const SESSION_IDLE_MS = 30 * 60 * 1000
export const SESSION_GC_INTERVAL_MS = 60 * 1000

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
  promptQueue: QueuedInbound[]
  contextBuffer: ObservedInbound[]
  draining: boolean
  debounceTimer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setInterval> | null
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
  consecutiveSends: Map<string, number>
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
}

type ChannelCommandContext = {
  live: LiveSession
  event: InboundMessage
}

export type ChannelRouter = {
  route: (event: InboundMessage) => Promise<void>
  send: (msg: OutboundMessage) => Promise<SendResult>
  getConsecutiveSendCount: (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }) => number
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
  stop: () => Promise<void>
  liveCount: () => number
  __testing?: {
    flushDebounce: (key: ChannelKey) => Promise<void>
    fireTypingHeartbeat: (key: ChannelKey) => Promise<void>
    isTypingActive: (key: ChannelKey) => boolean
    runIdleGc: () => Promise<void>
  }
}

export type CreateChannelRouterOptions = {
  agentDir: string
  configForAdapter: ConfigForAdapter
  createSessionForChannel?: CreateSessionForChannel
  sessionDir?: string
  logger?: RouterLogger
  // Test seam: clock for sticky/debounce/participants. Defaults to Date.now.
  now?: () => number
}

export function createChannelRouter(options: CreateChannelRouterOptions): ChannelRouter {
  const logger = options.logger ?? consoleLogger
  const now = options.now ?? Date.now
  const liveSessions = new Map<string, LiveSession>()
  const creating = new Map<string, Promise<LiveSession>>()
  const outboundCallbacks = new Map<ChannelKey['adapter'], Set<OutboundCallback>>()
  const typingCallbacks = new Map<ChannelKey['adapter'], Set<TypingCallback>>()
  const channelNameResolvers = new Map<ChannelKey['adapter'], Set<ChannelNameResolver>>()
  const membershipResolvers = new Map<ChannelKey['adapter'], Set<MembershipResolver>>()
  const membershipCaches = new Map<ChannelKey['adapter'], MembershipCache>()
  const historyCallbacks = new Map<ChannelKey['adapter'], Set<HistoryCallback>>()
  const stickyLedger = new StickyLedger()
  const commands = createCommandRegistry<ChannelCommandContext>([
    {
      name: 'stop',
      handler: async ({ live }) => {
        await stopCurrentChannelTurn(live)
      },
    },
  ])

  let mappings: ChannelSessionRecord[] | null = null
  let loadOnce: Promise<void> | null = null

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
    await saveChannelSessions(options.agentDir, mappings, logger)
  }

  const createForChannel: CreateSessionForChannel =
    options.createSessionForChannel ??
    (async ({ key, existingSessionId, existingSessionFile, origin }) => {
      const sessionDir = options.sessionDir ?? `${options.agentDir}/sessions`
      const sessionManager =
        existingSessionId !== undefined
          ? tryOpenSessionManager(options.agentDir, sessionDir, existingSessionId, existingSessionFile, logger)
          : SessionManager.create(options.agentDir, sessionDir)
      const session = await createSession({
        sessionManager,
        origin,
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
        const result = await resolver(key)
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

  const ensureLive = async (key: ChannelKey, triggeringMessageId?: string): Promise<LiveSession> => {
    const keyId = channelKeyId(key)
    const existing = liveSessions.get(keyId)
    if (existing && !existing.destroyed) return existing

    const inFlight = creating.get(keyId)
    if (inFlight) return inFlight

    const promise = (async () => {
      await ensureLoaded()
      const record = mappings ? findRecord(mappings, key) : undefined
      const participants = (record?.participants ?? []) as ChannelParticipant[]
      const membershipFetch = warmMembership(key)
      const resolvedNames = await resolveChannelNames(key)
      const membership = await membershipForPrompt(key, membershipFetch)
      const origin: SessionOrigin = {
        kind: 'channel',
        adapter: key.adapter,
        workspace: key.workspace,
        ...(resolvedNames.workspaceName !== undefined ? { workspaceName: resolvedNames.workspaceName } : {}),
        chat: key.chat,
        ...(resolvedNames.chatName !== undefined ? { chatName: resolvedNames.chatName } : {}),
        thread: key.thread,
        participants,
        ...(membership !== null ? { membership } : {}),
      }

      const isColdStart = record?.sessionId === undefined

      const created = await createForChannel({
        key,
        ...(record?.sessionId ? { existingSessionId: record.sessionId } : {}),
        ...(record?.sessionFile ? { existingSessionFile: record.sessionFile } : {}),
        participants,
        origin,
      })

      const transcriptPath = created.getTranscriptPath?.()
      const persistedRecord: ChannelSessionRecord = {
        adapter: key.adapter,
        workspace: key.workspace,
        chat: key.chat,
        thread: key.thread,
        sessionId: created.sessionId,
        ...(transcriptPath ? { sessionFile: basename(transcriptPath) } : {}),
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
        promptQueue: [],
        contextBuffer: [],
        draining: false,
        debounceTimer: null,
        typingTimer: null,
        lastInboundAt: 0,
        firstUnprocessedAt: 0,
        currentTurnAuthorId: null,
        currentTurnAuthorIds: new Set(),
        lastTurnAuthorIds: new Set(),
        consecutiveAborts: 0,
        consecutiveSends: new Map(),
        successfulChannelSends: 0,
        recentEngagedPeerBotTurns: [],
        consecutiveEngagedPeerBotTurns: 0,
        loopGuardActive: false,
        membershipFetch,
        destroyed: false,
      }
      liveSessions.set(keyId, live)

      if (isColdStart) {
        const adapterConfig = options.configForAdapter(key.adapter)
        if (adapterConfig) {
          await prefetchChannelContext(live, adapterConfig, triggeringMessageId)
        }
      }

      return live
    })()

    creating.set(keyId, promise)
    try {
      return await promise
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

  const regenerateOrigin = (live: LiveSession): SessionOrigin => buildLiveOrigin(live)

  const fireTyping = async (live: LiveSession): Promise<void> => {
    const callbacks = typingCallbacks.get(live.key.adapter)
    if (!callbacks || callbacks.size === 0) return
    // Snapshot before iterating: a callback could unregister mid-call.
    const snapshot = Array.from(callbacks)
    const target = {
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
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
    if (live.typingTimer || live.destroyed) return
    // Fire immediately so the indicator appears on the very first inbound,
    // not 8 seconds later.
    void fireTyping(live)
    live.typingTimer = setInterval(() => {
      if (live.destroyed) {
        stopTypingHeartbeat(live)
        return
      }
      void fireTyping(live)
    }, TYPING_HEARTBEAT_MS)
  }

  const stopTypingHeartbeat = (live: LiveSession): void => {
    if (!live.typingTimer) return
    clearInterval(live.typingTimer)
    live.typingTimer = null
  }

  const fireSessionIdle = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    try {
      await live.hooks.runSessionIdle({
        sessionId: live.sessionId,
        parentTranscriptPath: live.getTranscriptPath?.(),
        idleMs: 0,
        origin: buildLiveOrigin(live),
      })
    } catch (err) {
      logger.warn(`[channels] session.idle hook threw for ${live.keyId}: ${describe(err)}`)
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
    stopTypingHeartbeat(live)
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
      while (live.promptQueue.length > 0 && !live.destroyed) {
        // Heartbeat must run during generation as well as during debounce.
        // Because new inbounds during a turn just push into promptQueue
        // without re-entering route(), the route() call site alone wouldn't
        // keep the indicator alive across multiple drain iterations.
        startTypingHeartbeat(live)
        const batch = live.promptQueue.splice(0, live.promptQueue.length)
        const observed = live.contextBuffer.splice(0, live.contextBuffer.length)
        const text = composeTurnPrompt(observed, batch, { loopGuardActive: live.loopGuardActive })

        live.currentTurnAuthorId = batch.length > 0 ? batch[batch.length - 1]!.authorId : null
        live.currentTurnAuthorIds = new Set(batch.map((m) => m.authorId))
        if (batch.length > 0) live.consecutiveSends.clear()

        // The agent's view of the channel should reflect the current
        // participants + last inbound author. We update the in-memory
        // origin via the session-origin renderer, but the loader was
        // captured at session creation. v0.1 keeps the per-session loader
        // (so origin reflects participants at session-creation time);
        // per-prompt regeneration of system prompts is a v0.2 work.
        void regenerateOrigin

        // Bracketing logs around the LLM call so a hung prompt() is
        // diagnosable from logs alone (we see prompting without prompted).
        // text length is a proxy for "did we send something at all".
        logger.info(`[channels] ${live.keyId} prompting batch=${batch.length} text_len=${text.length}`)
        const promptStart = now()
        const successfulSendsBeforePrompt = live.successfulChannelSends
        try {
          await live.session.prompt(text)
          await validateChannelTurn(live, successfulSendsBeforePrompt)
          live.consecutiveAborts = 0
          logger.info(`[channels] ${live.keyId} prompted elapsed_ms=${now() - promptStart}`)
        } catch (err) {
          logger.warn(`[channels] ${live.keyId}: prompt threw: ${describe(err)}`)
          live.consecutiveSends.clear()
        }
        await fireSessionIdle(live)
        live.lastTurnAuthorIds = new Set(live.currentTurnAuthorIds)
      }
    } finally {
      live.draining = false
      live.currentTurnAuthorId = null
      live.currentTurnAuthorIds = new Set()
      stopTypingHeartbeat(live)
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

    const parsedCommand = commands.parse(event.text)
    if (parsedCommand !== null) {
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

    const live = await ensureLive(key, event.externalMessageId)

    live.participants = updateParticipants(
      live.participants,
      event.authorId,
      event.authorName,
      now(),
      event.authorIsBot,
    )
    void persistParticipants(live)

    const membership = await membershipForEngagement(live)

    const decision: EngagementDecision = decideEngagement({
      message: event,
      config: adapterConfig.engagement,
      key: live.keyId,
      ledger: stickyLedger,
      now: now(),
      participants: live.participants,
      membership,
    })

    if (decision === 'observe') {
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

  const observe = (live: LiveSession, event: InboundMessage): void => {
    live.contextBuffer.push({
      text: event.text,
      authorId: event.authorId,
      authorName: event.authorName,
      authorIsBot: event.authorIsBot,
      receivedAt: event.replyToBotMessageId === null ? now() : now(),
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
      const result = await cb(args)
      if (result.ok) return result
      lastError = result
    }
    return lastError
  }

  const send = async (msg: OutboundMessage): Promise<SendResult> => {
    const callbacks = outboundCallbacks.get(msg.adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `no adapter registered for "${msg.adapter}"` }
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
      return { ok: false, error: lastError ?? 'no callback accepted the outbound' }
    }

    const keyId = channelKeyId({
      adapter: msg.adapter,
      workspace: msg.workspace,
      chat: msg.chat,
      thread: msg.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    if (live) {
      live.successfulChannelSends++
      const adapterConfig = options.configForAdapter(msg.adapter)
      if (adapterConfig) {
        const targetIds = Array.from(
          live.currentTurnAuthorIds.size > 0 ? live.currentTurnAuthorIds : live.lastTurnAuthorIds,
        )
        if (targetIds.length > 0) {
          grantStickyForReplyTargets(stickyLedger, keyId, targetIds, adapterConfig.engagement, now())
        }
      }
      const sendKey = consecutiveSendKey(msg.chat, msg.thread)
      live.consecutiveSends.set(sendKey, (live.consecutiveSends.get(sendKey) ?? 0) + 1)
    }

    return { ok: true }
  }

  const validateChannelTurn = async (live: LiveSession, successfulSendsBeforePrompt: number): Promise<void> => {
    if (live.successfulChannelSends > successfulSendsBeforePrompt) return

    const assistantText = latestAssistantText(live.session)
    if (assistantText === null) return

    if (assistantText.trim() === 'NO_REPLY') {
      logger.info(`[channels] ${live.keyId} no_reply`)
      return
    }

    logger.warn(
      `[channels] ${live.keyId}: recovering assistant_text_without_channel_tool text_len=${assistantText.length}`,
    )
    const result = await send({
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      text: assistantText,
    })
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

  const tearDownLive = async (live: LiveSession): Promise<void> => {
    live.destroyed = true
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    live.debounceTimer = null
    stopTypingHeartbeat(live)
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

  return {
    route,
    send,
    getConsecutiveSendCount,
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
      fireTypingHeartbeat: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        await fireTyping(live)
      },
      isTypingActive: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        return live?.typingTimer !== null && live?.typingTimer !== undefined
      },
      runIdleGc,
    },
  }
}

function composeTurnPrompt(
  observed: readonly ObservedInbound[],
  batch: readonly QueuedInbound[],
  state: { loopGuardActive: boolean } = { loopGuardActive: false },
): string {
  const parts: string[] = []
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Used by tests / external diagnostics.
export type { ChannelSessionRecord }
export { channelsSessionsPath }
