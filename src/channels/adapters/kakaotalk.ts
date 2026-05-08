import type { ChannelRouter } from '@/channels/router'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
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

import {
  KakaoCredentialManager,
  KakaoTalkClient,
  KakaoTalkListener,
  type KakaoTalkPushMessageEvent,
} from './agent-messenger-kakaotalk-shim'
import { createKakaoAuthorResolver, type KakaoAuthorResolver } from './kakaotalk-author-resolver'
import { createKakaoChannelResolver, type KakaoChannelResolver } from './kakaotalk-channel-resolver'
import { classifyInbound, type InboundDropReason } from './kakaotalk-classify'

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
  configRef: () => ChannelAdapterConfig
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
}

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
          const authorName = await authorResolver.resolve(authorId, args.chat)
          return {
            externalMessageId: m.log_id,
            authorId,
            authorName,
            text: m.message,
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
  let listener: KakaoTalkListener | null = null
  let selfUserId: string | null = null
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createKakaoChannelResolver({ client, logger })
  const authorResolver = createKakaoAuthorResolver({ client })

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

  const handleMessageEvent = async (event: KakaoTalkPushMessageEvent): Promise<void> => {
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
        `[kakaotalk] inbound log_id=${event.log_id} author=${event.author_id} ${inboundTag} text_len=${event.message.length}`,
      )

      const verdict = classifyInbound(event, options.configRef(), {
        selfUserId,
        lookupChat: (id) => channelResolver.lookupChat(id),
        ...(options.selfAliasesRef ? { selfAliases: options.selfAliasesRef() } : {}),
      })
      if (verdict.kind === 'drop') {
        logger.info(`[kakaotalk] dropped log_id=${event.log_id} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }

      const authorName = await authorResolver.resolve(verdict.payload.authorId, verdict.payload.chat)
      const enriched = { ...verdict.payload, authorName }
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
      listener.on('connected', (info) => {
        connected = true
        logger.info(`[kakaotalk] connected (user_id=${info.userId})`)
      })
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[kakaotalk] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[kakaotalk] listener error: ${describe(err)}`)
      })
      listener.on('message', (event) => {
        void handleMessageEvent(event)
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
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('kakaotalk', outboundCallback)
      options.router.unregisterChannelNameResolver('kakaotalk', channelResolver.resolve)
      options.router.unregisterHistory('kakaotalk', historyCallback)
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
    },

    isConnected(): boolean {
      return connected && selfUserId !== null
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'not_in_allow_list':
      return ' (extend channels.kakaotalk.allow in typeclaw.json to admit this chat)'
    case 'unknown_chat':
      return ' (chat not in cache; resolver refresh may be lagging)'
    case 'empty_text':
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}
