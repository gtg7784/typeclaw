import {
  KakaoCredentialManager,
  KakaoTalkClient as RealKakaoTalkClient,
  KakaoTalkListener as RealKakaoTalkListener,
  type KakaoChat,
  type KakaoMember,
  type KakaoMessage,
  type KakaoProfile,
  type KakaoSendResult,
  type KakaoTalkListenerEventMap,
  type KakaoTalkPushEmoticonEvent,
  type KakaoTalkPushMessageEvent,
} from 'agent-messenger/kakaotalk'

import type { ChannelRouter } from '@/channels/router'
import { isAllowed, type ChannelAdapterConfig, type KakaotalkAdapterConfig } from '@/channels/schema'
import type {
  ChannelHistoryMessage,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
} from '@/channels/types'

import { emoticonEventToMessageEvent, formatHistoryText, formatInboundText } from './kakaotalk-attachment'
import { createKakaoAuthorResolver, type KakaoAuthorResolver } from './kakaotalk-author-resolver'
import { createKakaoChannelResolver, type KakaoChannelResolver } from './kakaotalk-channel-resolver'
import { classifyInbound, type InboundDropReason } from './kakaotalk-classify'
import { createFetchAttachmentCallback } from './kakaotalk-fetch-attachment'

// Inlined locally because agent-messenger/kakaotalk's index does not
// re-export KakaoMarkReadResult even though client.markRead returns it
// (agent-messenger 2.14.1). Upstream re-export fix is independent.
export interface KakaoMarkReadResult {
  success: boolean
  status_code: number
  chat_id: string
  watermark: string
}

// Structural duck-type of the upstream KakaoTalkClient class. The upstream
// type is a class with private fields, and TypeScript treats those
// nominally — test fakes that match the public surface get rejected.
// Declaring this as an interface lets fakes satisfy it without inheriting
// private state. The cast on the const below bridges the runtime class
// onto this interface; the real upstream class satisfies every method.
export interface KakaoTalkClient {
  login(
    credentials?: { oauthToken: string; userId: string; deviceUuid?: string; deviceType?: 'pc' | 'tablet' },
    accountId?: string,
  ): Promise<this>
  getChats(options?: { all?: boolean; search?: string }): Promise<KakaoChat[]>
  getMessages(chatId: string, options?: { count?: number; from?: string }): Promise<KakaoMessage[]>
  sendMessage(chatId: string, text: string): Promise<KakaoSendResult>
  markRead(chatId: string, logId: string, opts?: { linkId?: string }): Promise<KakaoMarkReadResult>
  getProfile(): Promise<KakaoProfile>
  getMembers(chatId: string): Promise<KakaoMember[]>
  lookupAuthorName(chatId: string, authorId: number): string | null
  close(): void
}

export interface KakaoTalkListener {
  start(): Promise<void>
  stop(): void
  on<K extends keyof KakaoTalkListenerEventMap>(
    event: K,
    listener: (...args: KakaoTalkListenerEventMap[K]) => void,
  ): this
  off<K extends keyof KakaoTalkListenerEventMap>(
    event: K,
    listener: (...args: KakaoTalkListenerEventMap[K]) => void,
  ): this
}

const KakaoTalkClient = RealKakaoTalkClient as unknown as new () => KakaoTalkClient
const KakaoTalkListener = RealKakaoTalkListener as unknown as new (client: KakaoTalkClient) => KakaoTalkListener

export type KakaotalkAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: KakaotalkAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type KakaotalkAdapterOptions = {
  router: ChannelRouter
  configRef: () => KakaotalkAdapterConfig
  logger?: KakaotalkAdapterLogger
  selfAliasesRef?: () => readonly string[]
  // When set, the adapter loads KakaoTalk credentials from this directory
  // (via KakaoCredentialManager(credentialsDir)) instead of relying on
  // the SDK's AGENT_MESSENGER_CONFIG_DIR env-var fallback. Production
  // wiring in src/channels/manager.ts passes the agent-folder workspace
  // path here so the adapter's credential resolution does NOT depend on
  // process.env state — easier to test, and removes a hidden coupling
  // with whatever set the env var (Dockerfile, CLI shell, etc.).
  credentialsDir?: string
  client?: KakaoTalkClient
  listenerFactory?: (client: KakaoTalkClient) => KakaoTalkListener
  // Test seam for KICKOUT auto-recovery. Production uses Date.now and
  // setTimeout. Tests inject deterministic clocks/schedulers so they can
  // assert the recovery semantics without real-time waits.
  now?: () => number
  scheduleRecovery?: (fn: () => void, delayMs: number) => void
}

// LOCO emits KICKOUT when the same device_uuid logs in elsewhere. Three
// shapes converge on this one signal:
//   1. Init handoff — `typeclaw init` left a brief session that the
//      container's re-login kicks. One delayed reconnect resolves it.
//   2. Ghost session — a previous run's LOCO connection is still
//      half-alive server-side and ping-pongs with our reconnect for
//      ~1-2 minutes until it times out. Old one-shot recovery
//      reconnected once, got kicked again, and died — the bug this
//      state machine exists to fix.
//   3. Real conflict — another device or process holds the same
//      device_uuid. Our retries can't win this fight; we should give up
//      cleanly so the user notices and intervenes.
// One signal, three shapes: we always try to recover, but with a
// strictly bounded budget. Within an episode we allow KICKOUT_RECOVERY_
// _DELAYS_MS.length retries spaced by the listed delays; an episode is
// declared successful only after the reconnect stays connected for
// SUCCESS_MS (bare `connected` is too weak — ghost ping-pong reconnects
// for seconds before getting kicked again). Past the budget or the
// MAX_ELAPSED cap we let the session die. After a successful episode
// the state resets, so a fresh KICKOUT hours later gets a fresh
// episode rather than being permanently locked out.
const KICKOUT_RECOVERY_SUCCESS_MS = 60_000
const KICKOUT_RECOVERY_MAX_ELAPSED_MS = 5 * 60_000
const KICKOUT_RECOVERY_DELAYS_MS: readonly number[] = [2_000, 10_000, 60_000]

export type KakaotalkAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export const KAKAO_HISTORY_LIMIT_MAX = 200

function formatLabel(name: string | undefined, id: string, prefix = ''): string {
  if (name === undefined || name === '' || name === id) return id
  return `${prefix}${name}(${id})`
}

export function createOutboundCallback(deps: {
  client: Pick<KakaoTalkClient, 'sendMessage'>
  configRef: () => ChannelAdapterConfig
  logger: KakaotalkAdapterLogger
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
}): OutboundCallback {
  const { client, configRef, logger, formatChannelTag } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'kakaotalk') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const config = configRef()
    if (!isAllowed(config.allow, msg.workspace, msg.chat)) {
      logger.warn(`[kakaotalk] outbound denied by allow rules: ${msg.workspace}/${msg.chat}`)
      return { ok: false, error: 'denied by allow rules' }
    }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (attachments.length > 0) {
      // Fail loudly rather than partial-send. The agent contract is "ok=true
      // means the request as a whole succeeded"; sending text while silently
      // dropping the attachments would let the agent confidently report
      // "I sent your file" when the file never arrived.
      logger.error(
        `[kakaotalk] outbound rejected: ${attachments.length} attachment(s) supplied but KakaoTalk is text-only`,
      )
      return {
        ok: false,
        error: 'KakaoTalk does not support attachments; send text without files or use a different channel for files',
      }
    }
    if (text === '') {
      return { ok: false, error: 'message has no text (KakaoTalk does not support attachment-only messages)' }
    }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(`[kakaotalk] outbound ${tag} text_len=${text.length}`)
    try {
      const result = await client.sendMessage(msg.chat, text)
      if (!result.success) {
        logger.error(`[kakaotalk] sendMessage status_code=${result.status_code} ${tag}`)
        return { ok: false, error: `kakaotalk send failed with status ${result.status_code}` }
      }
      logger.info(`[kakaotalk] sent log_id=${result.log_id} ${tag}`)
      return { ok: true }
    } catch (err) {
      const message = describe(err)
      logger.error(`[kakaotalk] sendMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createKakaoHistoryCallback(deps: {
  client: Pick<KakaoTalkClient, 'getMessages'>
  configRef: () => ChannelAdapterConfig
  logger: KakaotalkAdapterLogger
  channelResolver: Pick<KakaoChannelResolver, 'lookupChat' | 'refresh'>
  authorResolver: Pick<KakaoAuthorResolver, 'resolve'>
  selfUserIdRef: () => string | null
}): HistoryCallback {
  const { client, configRef, logger, channelResolver, authorResolver, selfUserIdRef } = deps
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const config = configRef()
    let lookup = channelResolver.lookupChat(args.chat)
    if (lookup === null) {
      await channelResolver.refresh()
      lookup = channelResolver.lookupChat(args.chat)
    }
    // Fallback to the most restrictive bucket (group) when the resolver
    // can't classify after refresh — keeps allow-rule enforcement strict
    // rather than defaulting to a permissive bucket.
    const workspace = lookup?.workspace ?? '@kakao-group'
    if (!isAllowed(config.allow, workspace, args.chat)) {
      return { ok: false, error: 'denied by allow rules' }
    }
    const limit = clampLimit(args.limit, KAKAO_HISTORY_LIMIT_MAX)
    try {
      const messages = await client.getMessages(args.chat, {
        count: limit,
        ...(args.cursor !== undefined && args.cursor !== '' ? { from: args.cursor } : {}),
      })
      const selfId = selfUserIdRef()
      const mapped: ChannelHistoryMessage[] = await Promise.all(
        messages.map(async (m) => {
          const authorId = String(m.author_id)
          const authorName = m.author_name ?? (await authorResolver.resolve(authorId, args.chat)) ?? authorId
          return {
            externalMessageId: m.log_id,
            authorId,
            authorName,
            text: formatHistoryText(m),
            ts: m.sent_at,
            isBot: selfId !== null && authorId === selfId,
            replyToBotMessageId: null,
          }
        }),
      )
      return { ok: true, messages: mapped }
    } catch (err) {
      const message = describe(err)
      logger.warn(`[kakaotalk] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

export function createKakaotalkAdapter(options: KakaotalkAdapterOptions): KakaotalkAdapter {
  const logger = options.logger ?? consoleLogger
  const client = options.client ?? new KakaoTalkClient()
  const now = options.now ?? Date.now
  const scheduleRecovery =
    options.scheduleRecovery ??
    ((fn: () => void, delayMs: number): void => {
      setTimeout(fn, delayMs)
    })
  let listener: KakaoTalkListener | null = null
  let selfUserId: string | null = null
  let connected = false
  let started = false
  let lastConnectedAt: number | null = null
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  type RecoveryEpisode = {
    startedAt: number
    attemptCount: number
    pendingStabilityCheck: boolean
  }
  let recoveryEpisode: RecoveryEpisode | null = null

  const resetRecoveryEpisode = (): void => {
    recoveryEpisode = null
  }

  const channelResolver = createKakaoChannelResolver({ client, logger })
  const authorResolver = createKakaoAuthorResolver({ client, logger })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver
      .resolve({ adapter: 'kakaotalk', workspace, chat, thread: null })
      .catch(() => ({}) as ResolvedChannelNames)
    return `bucket=${workspace} chat=${formatLabel(names.chatName, chat, '#')}`
  }

  const historyCallback = createKakaoHistoryCallback({
    client,
    configRef: options.configRef,
    logger,
    channelResolver,
    authorResolver,
    selfUserIdRef: () => selfUserId,
  })

  const outboundCallback = createOutboundCallback({
    client,
    configRef: options.configRef,
    logger,
    formatChannelTag,
  })

  const fetchAttachmentCallback = createFetchAttachmentCallback({ logger })

  const handleMessageEvent = async (event: KakaoTalkPushMessageEvent): Promise<void> => {
    // Synthesize the displayed text BEFORE classify so attachments
    // (photo, file, video, ...) survive classifyInbound's empty_text
    // drop and reach the agent with a `[KakaoTalk message with ...]`
    // placeholder. For text-only messages this is a no-op —
    // formatInboundText returns event.message unchanged. See
    // kakaotalk-attachment.ts for the per-message-type rules.
    await processInbound({ ...event, message: formatInboundText(event) })
  }

  const handleEmoticonEvent = async (event: KakaoTalkPushEmoticonEvent): Promise<void> => {
    // Stickers arrive on a separate listener event in agent-messenger
    // 2.15.0 and have no `message` field. We wrap them into the same
    // MSG-shaped payload classifyInbound expects so the engagement /
    // allow-list / self-author rules apply identically across plain
    // messages and stickers — there is no second classifier to keep in
    // sync.
    await processInbound(emoticonEventToMessageEvent(event))
  }

  const processInbound = async (event: KakaoTalkPushMessageEvent): Promise<void> => {
    inflightInbounds++
    try {
      if (channelResolver.lookupChat(event.chat_id) === null) {
        await channelResolver.refresh()
      }

      const inboundTag = await formatChannelTag(
        channelResolver.lookupChat(event.chat_id)?.workspace ?? '@kakao-group',
        event.chat_id,
      )
      logger.info(
        `[kakaotalk] inbound log_id=${event.log_id} author=${event.author_id} ${inboundTag} type=${event.message_type} text_len=${event.message.length}`,
      )

      // Ack the message BEFORE classify/route so the sender's unread "1"
      // (노란숫자) clears even when we drop the message (self-author,
      // not-in-allow, empty text, etc.). The receiver of a kakao adapter is
      // expected to behave like a "read it as soon as it arrives" client —
      // the agent has observed the bytes, so the user should see the read
      // acknowledgement regardless of what we decide to do with the message
      // downstream. Open-chat skip is enforced inside markReadIfSupported.
      markReadIfSupported({ client, event, channelResolver, logger })

      const verdict = classifyInbound(event, options.configRef(), {
        selfUserId,
        lookupChat: (id) => channelResolver.lookupChat(id),
        ...(options.selfAliasesRef ? { selfAliases: options.selfAliasesRef() } : {}),
      })
      if (verdict.kind === 'drop') {
        const bucket = channelResolver.lookupChat(event.chat_id)?.workspace ?? null
        logger.info(
          `[kakaotalk] dropped log_id=${event.log_id} reason=${verdict.reason}${dropHint(verdict.reason, bucket, event.chat_id)}`,
        )
        return
      }

      const inlineName = event.author_name
      const resolvedName = inlineName ?? (await authorResolver.resolve(verdict.payload.authorId, verdict.payload.chat))
      const enriched = {
        ...verdict.payload,
        authorName: resolvedName ?? verdict.payload.authorId,
      }
      logger.info(
        `[kakaotalk] routed log_id=${event.log_id} ${inboundTag} mention=${enriched.isBotMention} dm=${enriched.isDm}`,
      )
      await options.router.route(enriched)
    } catch (err) {
      logger.error(`[kakaotalk] handleInbound failed: ${describe(err)}`)
    } finally {
      inflightInbounds--
      if (inflightInbounds === 0 && stopWaiters.length > 0) {
        const waiters = stopWaiters
        stopWaiters = []
        for (const w of waiters) w()
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      lastConnectedAt = null
      resetRecoveryEpisode()
      try {
        if (options.credentialsDir !== undefined) {
          // Explicit credential path: read the file ourselves and pass the
          // tokens directly to client.login(). This bypasses the SDK's
          // ensureKakaoAuth() (which reads AGENT_MESSENGER_CONFIG_DIR or
          // ~/.config/agent-messenger), making the adapter independent of
          // process.env state.
          const credManager = new KakaoCredentialManager(options.credentialsDir)
          const account = await credManager.getAccount()
          if (account === null) {
            throw new Error(
              `no KakaoTalk account in ${options.credentialsDir}/kakaotalk-credentials.json (run typeclaw init to authenticate)`,
            )
          }
          await client.login({
            oauthToken: account.oauth_token,
            userId: account.user_id,
            deviceUuid: account.device_uuid,
            deviceType: account.device_type,
          })
        } else {
          // Fall back to the SDK's env-var-driven path. Honors
          // AGENT_MESSENGER_CONFIG_DIR set by the Dockerfile, otherwise
          // ~/.config/agent-messenger.
          await client.login()
        }
      } catch (err) {
        started = false
        logger.error(`[kakaotalk] login failed: ${describe(err)}`)
        throw err
      }

      try {
        const profile = await client.getProfile()
        selfUserId = profile.user_id
        logger.info(`[kakaotalk] authenticated as ${profile.nickname || profile.user_id} (${profile.user_id})`)
      } catch (err) {
        started = false
        logger.error(`[kakaotalk] getProfile failed: ${describe(err)}`)
        throw err
      }

      try {
        await channelResolver.refresh()
      } catch (err) {
        logger.warn(`[kakaotalk] initial chat list fetch failed: ${describe(err)}`)
      }

      listener = options.listenerFactory ? options.listenerFactory(client) : new KakaoTalkListener(client)
      const activeListener = listener
      const scheduleStabilityCheck = (): void => {
        if (recoveryEpisode === null) return
        if (recoveryEpisode.pendingStabilityCheck) return
        recoveryEpisode.pendingStabilityCheck = true
        const expectedConnectedAt = lastConnectedAt
        scheduleRecovery(() => {
          if (recoveryEpisode === null) return
          recoveryEpisode.pendingStabilityCheck = false
          if (!started || listener !== activeListener) return
          if (!connected || lastConnectedAt !== expectedConnectedAt) return
          logger.info(
            `[kakaotalk] KICKOUT recovery episode succeeded after ${recoveryEpisode.attemptCount} attempt(s); session is stable.`,
          )
          resetRecoveryEpisode()
        }, KICKOUT_RECOVERY_SUCCESS_MS)
      }
      listener.on('connected', (info) => {
        connected = true
        lastConnectedAt = now()
        logger.info(`[kakaotalk] connected (user_id=${info.userId})`)
        if (recoveryEpisode !== null) scheduleStabilityCheck()
      })
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[kakaotalk] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[kakaotalk] listener error: ${describe(err)}`)
        if (!isKickoutError(err)) return
        // KICKOUT closes the SDK session and skips scheduleReconnect, so
        // without intervention the adapter goes silent. We must either
        // start/continue a recovery episode or surface the dead state.
        connected = false
        if (!started) return
        const tNow = now()
        if (recoveryEpisode === null) {
          recoveryEpisode = { startedAt: tNow, attemptCount: 0, pendingStabilityCheck: false }
        }
        const episode = recoveryEpisode
        const elapsedInEpisode = tNow - episode.startedAt
        const nextAttemptIndex = episode.attemptCount
        const delayMs = KICKOUT_RECOVERY_DELAYS_MS[nextAttemptIndex]
        if (delayMs === undefined || elapsedInEpisode + delayMs > KICKOUT_RECOVERY_MAX_ELAPSED_MS) {
          const reason =
            delayMs === undefined
              ? `${KICKOUT_RECOVERY_DELAYS_MS.length} attempt(s) exhausted`
              : `${Math.round(KICKOUT_RECOVERY_MAX_ELAPSED_MS / 1000)}s recovery budget exhausted`
          logger.error(
            `[kakaotalk] session is DEAD after KICKOUT — ${reason}. ` +
              'Likely a real cross-device login is fighting our session. ' +
              'Stop the other client, then run `typeclaw restart`. ' +
              'If the conflict persists, re-run `typeclaw init` to mint a new device_uuid.',
          )
          resetRecoveryEpisode()
          return
        }
        episode.attemptCount = nextAttemptIndex + 1
        logger.warn(
          `[kakaotalk] KICKOUT during recovery episode (attempt ${episode.attemptCount}/${KICKOUT_RECOVERY_DELAYS_MS.length}, episode_elapsed=${Math.round(elapsedInEpisode)}ms); reconnecting in ${delayMs}ms.`,
        )
        scheduleRecovery(() => {
          if (!started || listener !== activeListener) return
          if (recoveryEpisode !== episode) return
          activeListener.start().catch((retryErr) => {
            logger.error(
              `[kakaotalk] KICKOUT auto-recovery failed: ${describe(retryErr)}. Run \`typeclaw restart\` to retry.`,
            )
          })
        }, delayMs)
      })
      listener.on('message', (event) => {
        void handleMessageEvent(event)
      })
      listener.on('emoticon', (event) => {
        void handleEmoticonEvent(event)
      })
      listener.on('member_joined', () => {
        void channelResolver.refresh()
      })
      listener.on('member_left', () => {
        void channelResolver.refresh()
      })

      try {
        await listener.start()
      } catch (err) {
        // Tear down defensively. Handlers (including the new 'emoticon'
        // one) were already wired before start(), and a partial start can
        // leave LOCO sockets half-open in the SDK. Without an explicit
        // stop here, a later adapter.stop() short-circuits on
        // !started and the listener leaks; with it, the SDK closes its
        // resources and our handler closures become unreachable.
        try {
          listener.stop()
        } catch {
          // ignore — best-effort cleanup, the start failure is what we surface
        }
        listener = null
        started = false
        logger.error(`[kakaotalk] listener start failed: ${describe(err)}`)
        throw err
      }

      // Registration intentionally happens AFTER listener.start() resolves
      // so a start failure cannot leave the router pointing at callbacks
      // belonging to a half-initialized adapter (the listener is closed,
      // but outboundCallback would still send via a dead client). Stop()
      // unregisters in the inverse order.
      options.router.registerOutbound('kakaotalk', outboundCallback)
      options.router.registerChannelNameResolver('kakaotalk', channelResolver.resolve)
      options.router.registerHistory('kakaotalk', historyCallback)
      options.router.registerFetchAttachment('kakaotalk', fetchAttachmentCallback)
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('kakaotalk', outboundCallback)
      options.router.unregisterChannelNameResolver('kakaotalk', channelResolver.resolve)
      options.router.unregisterHistory('kakaotalk', historyCallback)
      options.router.unregisterFetchAttachment('kakaotalk', fetchAttachmentCallback)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
      try {
        client.close()
      } catch {
        // close() throwing on a half-initialized client is benign; the
        // session is gone either way and there's nothing to recover.
      }
      selfUserId = null
      connected = false
      lastConnectedAt = null
      resetRecoveryEpisode()
    },

    isConnected(): boolean {
      return connected && selfUserId !== null
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function markReadIfSupported(deps: {
  client: Pick<KakaoTalkClient, 'markRead'>
  event: KakaoTalkPushMessageEvent
  channelResolver: Pick<KakaoChannelResolver, 'lookupChat'>
  logger: KakaotalkAdapterLogger
}): void {
  const { client, event, channelResolver, logger } = deps
  const bucket = channelResolver.lookupChat(event.chat_id)?.workspace
  if (bucket === '@kakao-open') {
    // Open chats require the LOCO `li` (linkId) field on NOTIREAD; without
    // it the server returns a non-success status. The resolver does not
    // surface linkId today, so rather than send a doomed ack we skip and
    // log once. Wiring linkId through the resolver is a follow-up.
    logger.info(
      `[kakaotalk] mark-read skipped chat=${event.chat_id} log=${event.log_id} reason=open_chat_link_id_unsupported`,
    )
    return
  }
  client.markRead(event.chat_id, event.log_id).then(
    (result) => {
      if (!result.success) {
        logger.warn(
          `[kakaotalk] mark-read non-success status_code=${result.status_code} chat=${event.chat_id} log=${event.log_id}`,
        )
      }
    },
    (err) => {
      logger.warn(`[kakaotalk] mark-read failed: ${describe(err)} chat=${event.chat_id} log=${event.log_id}`)
    },
  )
}

function dropHint(
  reason: InboundDropReason,
  bucket: '@kakao-dm' | '@kakao-group' | '@kakao-open' | null,
  chatId: string,
): string {
  switch (reason) {
    case 'not_in_allow_list':
      return ` (add ${suggestedAllowPattern(bucket, chatId)} to channels.kakaotalk.allow to admit this chat)`
    case 'unknown_chat':
      return ' (chat not in cache; resolver refresh may be lagging)'
    case 'empty_text':
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}

function suggestedAllowPattern(bucket: '@kakao-dm' | '@kakao-group' | '@kakao-open' | null, chatId: string): string {
  if (bucket === '@kakao-dm') return `"kakao:dm/*" or "kakao:${chatId}"`
  if (bucket === '@kakao-group') return `"kakao:group/*" or "kakao:${chatId}"`
  if (bucket === '@kakao-open') return `"kakao:open/*" or "kakao:${chatId}"`
  return `"kakao:${chatId}"`
}

function isKickoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.message.includes('kicked') || err.message.includes('KICKOUT')
}
