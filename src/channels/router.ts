import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession, type AgentSession } from '@/agent'
import type { ChannelParticipant, SessionOrigin } from '@/agent/session-origin'

import { decideEngagement, grantStickyForReplyTargets, StickyLedger, type EngagementDecision } from './engagement'
import { updateParticipants } from './participants'
import {
  channelsSessionsPath,
  findRecord,
  loadChannelSessions,
  saveChannelSessions,
  type ChannelSessionRecord,
} from './persistence'
import type { ChannelAdapterConfig } from './schema'
import type { ChannelKey, InboundMessage, OutboundCallback, OutboundMessage, SendResult, TypingCallback } from './types'
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
  participants: readonly ChannelParticipant[]
  origin: SessionOrigin
}) => Promise<{ session: AgentSession; sessionId: string; dispose: () => Promise<void> }>

export type ConfigForAdapter = (adapter: ChannelKey['adapter']) => ChannelAdapterConfig | undefined

type QueuedInbound = {
  text: string
  authorId: string
  authorName: string
  externalMessageId: string
  isBotMention: boolean
  replyToBotMessageId: string | null
  isDm: boolean
  receivedAt: number
}

type ObservedInbound = {
  text: string
  authorId: string
  authorName: string
  receivedAt: number
}

type LiveSession = {
  key: ChannelKey
  keyId: string
  session: AgentSession
  sessionId: string
  dispose: () => Promise<void>
  participants: ChannelParticipant[]
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
  destroyed: boolean
}

export type ChannelRouter = {
  route: (event: InboundMessage) => Promise<void>
  send: (msg: OutboundMessage) => Promise<SendResult>
  registerOutbound: (adapter: ChannelKey['adapter'], cb: OutboundCallback) => void
  unregisterOutbound: (adapter: ChannelKey['adapter'], cb: OutboundCallback) => void
  registerTyping: (adapter: ChannelKey['adapter'], cb: TypingCallback) => void
  unregisterTyping: (adapter: ChannelKey['adapter'], cb: TypingCallback) => void
  stop: () => Promise<void>
  liveCount: () => number
  __testing?: {
    flushDebounce: (key: ChannelKey) => Promise<void>
    fireTypingHeartbeat: (key: ChannelKey) => Promise<void>
    isTypingActive: (key: ChannelKey) => boolean
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
  const stickyLedger = new StickyLedger()

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
    (async ({ key, existingSessionId, origin }) => {
      const sessionDir = options.sessionDir ?? `${options.agentDir}/sessions`
      const sessionManager = existingSessionId
        ? tryOpenSessionManager(options.agentDir, sessionDir, existingSessionId, logger)
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
      }
    })

  const ensureLive = async (key: ChannelKey): Promise<LiveSession> => {
    const keyId = channelKeyId(key)
    const existing = liveSessions.get(keyId)
    if (existing && !existing.destroyed) return existing

    const inFlight = creating.get(keyId)
    if (inFlight) return inFlight

    const promise = (async () => {
      await ensureLoaded()
      const record = mappings ? findRecord(mappings, key) : undefined
      const participants = (record?.participants ?? []) as ChannelParticipant[]
      const origin: SessionOrigin = {
        kind: 'channel',
        adapter: key.adapter,
        workspace: key.workspace,
        chat: key.chat,
        thread: key.thread,
        participants,
      }

      const created = await createForChannel({
        key,
        ...(record?.sessionId ? { existingSessionId: record.sessionId } : {}),
        participants,
        origin,
      })

      const persistedRecord: ChannelSessionRecord = {
        adapter: key.adapter,
        workspace: key.workspace,
        chat: key.chat,
        thread: key.thread,
        sessionId: created.sessionId,
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
        participants,
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
        destroyed: false,
      }
      liveSessions.set(keyId, live)
      return live
    })()

    creating.set(keyId, promise)
    try {
      return await promise
    } finally {
      creating.delete(keyId)
    }
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

  const regenerateOrigin = (live: LiveSession): SessionOrigin => ({
    kind: 'channel',
    adapter: live.key.adapter,
    workspace: live.key.workspace,
    chat: live.key.chat,
    thread: live.key.thread,
    participants: live.participants,
  })

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
        const text = composeTurnPrompt(observed, batch)

        live.currentTurnAuthorId = batch.length > 0 ? batch[batch.length - 1]!.authorId : null
        live.currentTurnAuthorIds = new Set(batch.map((m) => m.authorId))

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
        try {
          await live.session.prompt(text)
          live.consecutiveAborts = 0
          logger.info(`[channels] ${live.keyId} prompted elapsed_ms=${now() - promptStart}`)
        } catch (err) {
          logger.warn(`[channels] ${live.keyId}: prompt threw: ${describe(err)}`)
        }
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
    const live = await ensureLive(key)

    live.participants = updateParticipants(live.participants, event.authorId, event.authorName, now())
    void persistParticipants(live)

    const decision: EngagementDecision = decideEngagement({
      message: event,
      config: adapterConfig.engagement,
      key: live.keyId,
      ledger: stickyLedger,
      now: now(),
      participants: live.participants,
    })

    if (decision === 'observe') {
      observe(live, event)
      return
    }

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

  const observe = (live: LiveSession, event: InboundMessage): void => {
    live.contextBuffer.push({
      text: event.text,
      authorId: event.authorId,
      authorName: event.authorName,
      receivedAt: event.replyToBotMessageId === null ? now() : now(),
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
      externalMessageId: event.externalMessageId,
      isBotMention: event.isBotMention,
      replyToBotMessageId: event.replyToBotMessageId,
      isDm: event.isDm,
      receivedAt: now(),
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
      const adapterConfig = options.configForAdapter(msg.adapter)
      if (adapterConfig) {
        const targetIds = Array.from(
          live.currentTurnAuthorIds.size > 0 ? live.currentTurnAuthorIds : live.lastTurnAuthorIds,
        )
        if (targetIds.length > 0) {
          grantStickyForReplyTargets(stickyLedger, keyId, targetIds, adapterConfig.engagement, now())
        }
      }
    }

    return { ok: true }
  }

  const stop = async (): Promise<void> => {
    const all = Array.from(liveSessions.values())
    liveSessions.clear()
    for (const live of all) {
      live.destroyed = true
      if (live.debounceTimer) clearTimeout(live.debounceTimer)
      live.debounceTimer = null
      stopTypingHeartbeat(live)
      try {
        await live.session.abort()
      } catch (err) {
        logger.warn(`[channels] abort failed for ${live.keyId}: ${describe(err)}`)
      }
      try {
        await live.dispose()
      } catch (err) {
        logger.warn(`[channels] dispose failed for ${live.keyId}: ${describe(err)}`)
      }
    }
  }

  return {
    route,
    send,
    registerOutbound,
    unregisterOutbound,
    registerTyping,
    unregisterTyping,
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
    },
  }
}

function composeTurnPrompt(observed: readonly ObservedInbound[], batch: readonly QueuedInbound[]): string {
  const parts: string[] = []
  if (observed.length > 0) {
    parts.push('## Recent context (not addressed to you, for awareness only)')
    for (const o of observed) {
      parts.push(`<@${o.authorId}> (${o.authorName}): ${o.text}`)
    }
    parts.push('')
    parts.push(batch.length === 1 ? '## Current message (addressed to you)' : '## Current messages (addressed to you)')
  }
  for (const b of batch) {
    parts.push(`<@${b.authorId}> (${b.authorName}): ${b.text}`)
  }
  return parts.join('\n')
}

function tryOpenSessionManager(
  agentDir: string,
  sessionDir: string,
  existingSessionId: string,
  logger: RouterLogger,
): SessionManager {
  try {
    const path = `${sessionDir}/${existingSessionId}.jsonl`
    return SessionManager.open(path)
  } catch (err) {
    logger.warn(`[channels] could not rehydrate session ${existingSessionId}: ${describe(err)}; creating new`)
    return SessionManager.create(agentDir, sessionDir)
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Used by tests / external diagnostics.
export type { ChannelSessionRecord }
export { channelsSessionsPath }
