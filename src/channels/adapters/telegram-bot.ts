import { TelegramBotClient, TelegramBotListener } from 'agent-messenger/telegrambot'
import type { TelegramBotUser, TelegramMessage } from 'agent-messenger/telegrambot'

import {
  MEMBERSHIP_ENUMERATION_CAP,
  type MembershipResolver,
  type MembershipResolverFailure,
  type MembershipResolverResult,
} from '@/channels/membership'
import type { ChannelRouter } from '@/channels/router'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type {
  ChannelNameResolver,
  FetchAttachmentCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
  TypingCallback,
  TypingTarget,
} from '@/channels/types'

import { classifyInbound, type InboundDropReason, TELEGRAM_WORKSPACE } from './telegram-bot-classify'

export const TELEGRAM_API_BASE = 'https://api.telegram.org'

const TELEGRAM_ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post']

// HTML is the default outbound `parse_mode`: agents naturally produce
// markdown-y text and MarkdownV2's strict escaping rules (every `.`, `!`,
// `(`, `)`, `_`, `*`, `[`, `]`, `~`, etc.) would crash a meaningful
// fraction of replies. HTML's escaping is limited to `<`, `>`, `&`, which
// the formatter handles before send.
export const TELEGRAM_DEFAULT_PARSE_MODE = 'HTML' as const

export type TelegramBotAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: TelegramBotAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type TelegramBotAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  token: string
  logger?: TelegramBotAdapterLogger
}

export type TelegramBotAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export function createTypingCallback(deps: {
  client: Pick<TelegramBotClient, 'setMessageReaction'> & {
    sendChatAction?: (chatId: string | number, action: string) => Promise<unknown>
  }
  token: string
  configRef: () => ChannelAdapterConfig
  logger: TelegramBotAdapterLogger
  formatChannelTag?: (chat: string) => Promise<string>
  fetchImpl?: typeof fetch
}): TypingCallback {
  const { token, configRef, logger, formatChannelTag } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'telegram-bot') return
    // Telegram's `sendChatAction` indicator auto-expires after ~5s. We
    // re-fire on each router tick (every 8s while debouncing/generating);
    // a missed beat just gaps the indicator. There is no explicit clear,
    // so the 'stop' phase is a no-op.
    if (target.phase === 'stop') return
    const config = configRef()
    if (!isAllowed(config.allow, target.workspace, target.chat)) return
    const tag = formatChannelTag ? await formatChannelTag(target.chat) : `chat=${target.chat}`
    const body: Record<string, unknown> = { chat_id: target.chat, action: 'typing' }
    if (target.thread !== null && target.thread !== undefined) {
      body.message_thread_id = Number(target.thread)
    }
    try {
      const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        logger.warn(`[telegram-bot] typing ${tag} status=${response.status}`)
      }
    } catch (err) {
      logger.warn(`[telegram-bot] typing ${tag} failed: ${describe(err)}`)
    }
  }
}

export function createChannelNameResolver(deps: {
  client: Pick<TelegramBotClient, 'getChat'>
  ttlMs?: number
  now?: () => number
}): ChannelNameResolver {
  const ttlMs = deps.ttlMs ?? 24 * 60 * 60 * 1000
  const now = deps.now ?? Date.now
  const cache = new Map<string, { value: string; expiresAt: number }>()

  return async (key): Promise<ResolvedChannelNames> => {
    if (key.adapter !== 'telegram-bot') return {}
    const cached = cache.get(key.chat)
    if (cached && cached.expiresAt > now()) {
      return { chatName: cached.value }
    }
    try {
      const chat = await deps.client.getChat(key.chat)
      const name = chatLabel(chat)
      if (name === null) return {}
      cache.set(key.chat, { value: name, expiresAt: now() + ttlMs })
      return { chatName: name }
    } catch {
      return {}
    }
  }
}

function chatLabel(chat: {
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}): string | null {
  if (chat.title !== undefined && chat.title !== '') return chat.title
  if (chat.username !== undefined && chat.username !== '') return `@${chat.username}`
  const first = chat.first_name ?? ''
  const last = chat.last_name ?? ''
  if (first === '' && last === '') return null
  return last === '' ? first : `${first} ${last}`
}

export function createTelegramMembershipResolver(deps: {
  client: Pick<TelegramBotClient, 'getChat' | 'getChatMemberCount'>
  logger: TelegramBotAdapterLogger
  now?: () => number
}): MembershipResolver {
  const now = deps.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'telegram-bot') return { kind: 'permanent' } satisfies MembershipResolverFailure
    try {
      const chat = await deps.client.getChat(key.chat)
      // 1:1 chats have no /members endpoint and are exactly the bot + the
      // user; report the canonical pair so the engagement layer can apply
      // the DM trigger without a network round-trip per inbound.
      if (chat.type === 'private') {
        return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }
      }
      const count = await deps.client.getChatMemberCount(key.chat)
      const total = Math.max(0, Math.floor(count))
      // Telegram's Bot API does not expose a per-member listing for groups
      // beyond `getChatAdministrators`, so we cannot split humans from
      // bots cheaply. For chats above the enumeration cap we return the
      // raw count as humans (bots=0) and mark it truncated; for smaller
      // chats we still cannot enumerate, so the same shape applies. The
      // engagement layer treats "many participants" as an overall room
      // size and the bot/human split is informational at that scale.
      return {
        humans: total,
        bots: 0,
        fetchedAt: now(),
        truncated: total > MEMBERSHIP_ENUMERATION_CAP,
      }
    } catch (err) {
      deps.logger.warn(`[telegram-bot] membership chat=${key.chat} failed: ${describe(err)}`)
      return { kind: 'transient' } satisfies MembershipResolverFailure
    }
  }
}

export function createOutboundCallback(deps: {
  client: Pick<TelegramBotClient, 'sendMessage' | 'sendDocument'>
  configRef: () => ChannelAdapterConfig
  logger: TelegramBotAdapterLogger
  formatChannelTag: (chat: string) => Promise<string>
  resolvePath?: (path: string) => string
}): OutboundCallback {
  const { client, configRef, logger, formatChannelTag, resolvePath } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'telegram-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const config = configRef()
    if (!isAllowed(config.allow, msg.workspace, msg.chat)) {
      logger.warn(`[telegram-bot] outbound denied by allow rules: ${msg.workspace}/${msg.chat}`)
      return { ok: false, error: 'denied by allow rules' }
    }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) {
      return { ok: false, error: 'message has neither text nor attachments' }
    }
    const tag = await formatChannelTag(msg.chat)
    logger.info(
      `[telegram-bot] outbound ${tag} text_len=${text.length} attachments=${attachments.length}${msg.thread !== null && msg.thread !== undefined ? ` thread=${msg.thread}` : ''}`,
    )

    // Telegram has no combined "text + attachment" send for arbitrary
    // documents — `sendDocument` accepts a `caption` but it shares
    // Telegram's 1024-char limit, so we send them as separate calls
    // (uploads first so the agent's text comment lands in the chat after
    // the file the user is meant to read). Failure on any upload aborts:
    // the file is the load-bearing piece, the text post is best-effort
    // after every upload succeeds.
    const threadId = parseThreadId(msg.thread)
    for (const attachment of attachments) {
      const path = resolvePath ? resolvePath(attachment.path) : attachment.path
      try {
        const sent = await client.sendDocument(msg.chat, path)
        logger.info(`[telegram-bot] uploaded message_id=${sent.message_id} ${tag}`)
      } catch (err) {
        const message = describe(err)
        logger.error(`[telegram-bot] sendDocument failed for ${path}: ${message}`)
        return { ok: false, error: `sendDocument failed: ${message}` }
      }
    }

    if (text === '') {
      return { ok: true }
    }

    try {
      const sendOptions: { parse_mode: 'HTML'; message_thread_id?: number } = {
        parse_mode: TELEGRAM_DEFAULT_PARSE_MODE,
      }
      if (threadId !== undefined) sendOptions.message_thread_id = threadId
      const sent = await client.sendMessage(msg.chat, text, sendOptions)
      logger.info(`[telegram-bot] sent message_id=${sent.message_id} ${tag}`)
      return { ok: true }
    } catch (err) {
      const message = describe(err)
      logger.error(`[telegram-bot] sendMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

function parseThreadId(thread: string | null | undefined): number | undefined {
  if (thread === null || thread === undefined || thread === '') return undefined
  const n = Number(thread)
  return Number.isFinite(n) ? n : undefined
}

type TelegramFileResponse = {
  ok: boolean
  result?: { file_id: string; file_unique_id: string; file_size?: number; file_path?: string }
  description?: string
}

// Telegram's file download is a two-step protocol: `getFile` returns a
// short-lived `file_path`, then the file lives at
// `api.telegram.org/file/bot<TOKEN>/<file_path>`. `ref` here is the
// `file_id` carried in the inbound classifier's `[Telegram message with
// document: ... file_id=<id>]` summary; the agent passes it back through
// the `channel_fetch_attachment` tool. We refuse non-file_id refs so the
// bot token is never sent to attacker-controlled URLs (parity with the
// Discord adapter's host-allowlist check).
export function createFetchAttachmentCallback(deps: {
  token: string
  logger: TelegramBotAdapterLogger
  fetchImpl?: typeof fetch
}): FetchAttachmentCallback {
  const { token, logger } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  return async ({ ref, filename }) => {
    if (ref === '' || ref.includes('/') || ref.includes('://')) {
      return { ok: false, error: `invalid Telegram file_id: ${ref}` }
    }
    let metaResponse: Response
    try {
      metaResponse = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(ref)}`)
    } catch (err) {
      const message = describe(err)
      logger.error(`[telegram-bot] getFile failed for ${ref}: ${message}`)
      return { ok: false, error: `getFile failed: ${message}` }
    }
    if (!metaResponse.ok) {
      const body = await metaResponse.text().catch(() => '')
      const message = `getFile ${metaResponse.status} ${metaResponse.statusText}${body !== '' ? `: ${body.slice(0, 200)}` : ''}`
      logger.error(`[telegram-bot] getFile failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
    let meta: TelegramFileResponse
    try {
      meta = (await metaResponse.json()) as TelegramFileResponse
    } catch (err) {
      return { ok: false, error: `getFile parse failed: ${describe(err)}` }
    }
    if (!meta.ok || meta.result === undefined || meta.result.file_path === undefined) {
      const message = meta.description ?? 'getFile returned no file_path'
      return { ok: false, error: message }
    }
    const filePath = meta.result.file_path
    const downloadUrl = `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`
    let response: Response
    try {
      response = await fetchImpl(downloadUrl)
    } catch (err) {
      const message = describe(err)
      logger.error(`[telegram-bot] download failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const message = `download ${response.status} ${response.statusText}${body !== '' ? `: ${body.slice(0, 200)}` : ''}`
      logger.error(`[telegram-bot] download failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const inferredFilename = filename ?? filePath.split('/').pop() ?? 'attachment'
    const contentType = response.headers.get('content-type') ?? undefined
    logger.info(
      `[telegram-bot] downloaded file_id=${ref} name=${inferredFilename} size=${buffer.length}${contentType !== undefined ? ` type=${contentType}` : ''}`,
    )
    return {
      ok: true,
      buffer,
      filename: inferredFilename,
      ...(contentType !== undefined ? { mimetype: contentType } : {}),
      size: buffer.length,
    }
  }
}

export function createTelegramBotAdapter(options: TelegramBotAdapterOptions): TelegramBotAdapter {
  const logger = options.logger ?? consoleLogger
  const client = new TelegramBotClient()
  let listener: TelegramBotListener | null = null
  let botUser: TelegramBotUser | null = null
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createChannelNameResolver({ client })

  const formatChannelTag = async (chat: string): Promise<string> => {
    const names = await channelResolver({
      adapter: 'telegram-bot',
      workspace: TELEGRAM_WORKSPACE,
      chat,
      thread: null,
    }).catch((): ResolvedChannelNames => ({}))
    const label = names.chatName ?? null
    return label === null || label === chat ? `chat=${chat}` : `chat=${label}(${chat})`
  }

  const typingCallback = createTypingCallback({
    client,
    token: options.token,
    configRef: options.configRef,
    logger,
    formatChannelTag,
  })

  const membershipResolver = createTelegramMembershipResolver({ client, logger })

  const outboundCallback = createOutboundCallback({
    client,
    configRef: options.configRef,
    logger,
    formatChannelTag,
  })

  const fetchAttachmentCallback = createFetchAttachmentCallback({ token: options.token, logger })

  const handleMessage = async (event: TelegramMessage): Promise<void> => {
    inflightInbounds++
    try {
      const tag = await formatChannelTag(String(event.chat.id))
      const fromLabel = event.from?.username ?? event.from?.first_name ?? String(event.from?.id ?? '?')
      const text = event.text ?? event.caption ?? ''
      logger.info(
        `[telegram-bot] inbound message_id=${event.message_id} author=${fromLabel} ${tag} text_len=${text.length}`,
      )

      const verdict = classifyInbound(event, options.configRef(), botUser)
      if (verdict.kind === 'drop') {
        logger.info(
          `[telegram-bot] dropped message_id=${event.message_id} reason=${verdict.reason}${dropHint(verdict.reason)}`,
        )
        return
      }

      logger.info(
        `[telegram-bot] routed message_id=${event.message_id} ${tag} mention=${verdict.payload.isBotMention} reply=${verdict.payload.replyToBotMessageId !== null}`,
      )
      await options.router.route(verdict.payload)
    } catch (err) {
      logger.error(`[telegram-bot] handleInbound failed: ${describe(err)}`)
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
        await client.login({ token: options.token })
      } catch (err) {
        started = false
        logger.error(`[telegram-bot] login failed: ${describe(err)}`)
        throw err
      }

      listener = new TelegramBotListener(client, {
        timeoutSeconds: 30,
        allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
        dropPendingUpdates: true,
      })
      listener.on('connected', (info) => {
        botUser = info.user
        const handle = info.user.username !== undefined ? `@${info.user.username}` : info.user.first_name
        logger.info(`[telegram-bot] connected as ${handle} (${info.user.id})`)
      })
      listener.on('disconnected', () => {
        logger.warn('[telegram-bot] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[telegram-bot] listener error: ${describe(err)}`)
      })
      listener.on('message', (event) => {
        void handleMessage(event)
      })
      listener.on('channel_post', (event) => {
        void handleMessage(event)
      })

      options.router.registerOutbound('telegram-bot', outboundCallback)
      options.router.registerTyping('telegram-bot', typingCallback)
      options.router.registerChannelNameResolver('telegram-bot', channelResolver)
      options.router.registerFetchAttachment('telegram-bot', fetchAttachmentCallback)
      options.router.registerMembership('telegram-bot', membershipResolver)

      try {
        await listener.start()
      } catch (err) {
        started = false
        logger.error(`[telegram-bot] listener start failed: ${describe(err)}`)
        throw err
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('telegram-bot', outboundCallback)
      options.router.unregisterTyping('telegram-bot', typingCallback)
      options.router.unregisterChannelNameResolver('telegram-bot', channelResolver)
      options.router.unregisterFetchAttachment('telegram-bot', fetchAttachmentCallback)
      options.router.unregisterMembership('telegram-bot', membershipResolver)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
    },

    isConnected(): boolean {
      return botUser !== null
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'no_user':
      return ' (channel post / anonymous; cannot attribute to an author)'
    case 'empty_text':
      return ' (message had no text and no recognized media; check Telegram privacy mode in @BotFather)'
    case 'not_in_allow_list':
      return ' (extend channels.telegram-bot.allow in typeclaw.json to admit this chat)'
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}
