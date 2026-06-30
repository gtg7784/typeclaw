import * as instagramModule from 'agent-messenger/instagram'
import {
  InstagramClient as RealInstagramClient,
  InstagramCredentialManager,
  InstagramListener as RealInstagramListener,
} from 'agent-messenger/instagram'
import type { InstagramChatSummary, InstagramMessageSummary } from 'agent-messenger/instagram'

import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
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

import { describeError } from './describe-error'
import { createInstagramChannelResolver } from './instagram-channel-resolver'
import { classifyInbound } from './instagram-classify'
import { toInstagramPlainText } from './instagram-format'

export interface InstagramClientShape {
  login(credentials?: { username: string; password: string }, accountId?: string): Promise<this>
  getProfile(): Promise<{ user_id: string; username: string; full_name: string | null; profile_pic_url: string | null }>
  listChats(limit?: number): Promise<InstagramChatSummary[]>
  getMessages(threadId: string, limit?: number): Promise<InstagramMessageSummary[]>
  sendMessage(threadId: string, text: string): Promise<InstagramMessageSummary>
  getUserId(): string | null
  fetchIrisBootstrap?: () => Promise<unknown>
  getSessionState?: () => unknown
}

export type ConnectedPayload = { userId: string; transport?: 'realtime' | 'polling' }

export interface InstagramListenerShape {
  start(): Promise<void> | void
  stop(): void
  on(event: 'connected', handler: (payload: ConnectedPayload) => void): this
  on(event: 'message', handler: (message: InstagramMessageSummary) => void): this
  on(event: 'error', handler: (error: Error) => void): this
  on(event: 'disconnected', handler: () => void): this
  off(event: 'connected', handler: (payload: ConnectedPayload) => void): this
  off(event: 'message', handler: (message: InstagramMessageSummary) => void): this
  off(event: 'error', handler: (error: Error) => void): this
  off(event: 'disconnected', handler: () => void): this
}

const InstagramClient = RealInstagramClient as unknown as new (
  credManager?: InstagramCredentialManager,
) => InstagramClientShape

export type InstagramListenerCtor = new (
  client: InstagramClientShape,
  options?: {
    pollInterval?: number
    realtimeRetryBaseMs?: number
    realtimeRetryMaxMs?: number
    disableRealtime?: boolean
    connackTimeoutMs?: number
  },
) => InstagramListenerShape

export function resolveInstagramListenerCtor(): { ctor: InstagramListenerCtor; transport: 'hybrid' | 'polling' } {
  const maybeHybrid = (instagramModule as Record<string, unknown>).InstagramHybridListener
  if (typeof maybeHybrid === 'function')
    return { ctor: maybeHybrid as unknown as InstagramListenerCtor, transport: 'hybrid' }
  return { ctor: RealInstagramListener as unknown as InstagramListenerCtor, transport: 'polling' }
}

export type InstagramCredentialStore = {
  getAccount(id?: string): Promise<{ account_id: string } | null>
}

export type InstagramAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: InstagramAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type InstagramAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: InstagramAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: InstagramCredentialStore
  client?: InstagramClientShape
  clientFactory?: (credManager?: InstagramCredentialManager) => InstagramClientShape
  listenerCtorResolver?: () => { ctor: InstagramListenerCtor; transport: 'hybrid' | 'polling' }
  now?: () => number
}

export type InstagramAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export const INSTAGRAM_HISTORY_LIMIT_MAX = 200

export function createOutboundCallback(deps: {
  client: Pick<InstagramClientShape, 'sendMessage'>
  logger: InstagramAdapterLogger
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
}): OutboundCallback {
  const { client, logger, formatChannelTag } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'instagram') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    if (msg.attachments !== undefined && msg.attachments.length > 0) {
      return { ok: false, error: 'instagram adapter does not support outbound attachments' }
    }
    const text = toInstagramPlainText(msg.text ?? '')
    if (text === '') return { ok: false, error: 'message has no text' }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(`[instagram] outbound ${tag} text_len=${text.length}`)
    try {
      const result = await client.sendMessage(msg.chat, text)
      logger.info(`[instagram] sent message_id=${result.id} ${tag}`)
      return { ok: true, messageId: result.id, messageIds: [result.id] }
    } catch (err) {
      const message = describeError(err)
      logger.error(`[instagram] sendMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createInstagramHistoryCallback(deps: {
  client: Pick<InstagramClientShape, 'getMessages'>
  logger: InstagramAdapterLogger
  selfUserIdRef: () => string | null
}): HistoryCallback {
  const { client, logger, selfUserIdRef } = deps
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const limit = clampLimit(args.limit, INSTAGRAM_HISTORY_LIMIT_MAX)
    try {
      const messages = await client.getMessages(args.chat, limit)
      const selfId = selfUserIdRef()
      const mapped: ChannelHistoryMessage[] = messages.map((m) => {
        const parsed = Date.parse(m.timestamp)
        return {
          externalMessageId: m.id,
          authorId: m.from,
          authorName: m.from_name ?? m.from,
          text: m.text ?? '',
          ts: Number.isNaN(parsed) ? 0 : parsed,
          isBot: selfId !== null && (m.from === selfId || m.is_outgoing),
          replyToBotMessageId: null,
        }
      })
      return { ok: true, messages: mapped }
    } catch (err) {
      const message = describeError(err)
      logger.warn(`[instagram] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createInstagramAdapter(options: InstagramAdapterOptions): InstagramAdapter {
  const logger = options.logger ?? consoleLogger
  const buildClient = options.clientFactory ?? ((cm?: InstagramCredentialManager) => new InstagramClient(cm))
  const client = options.client ?? buildClient(new InstagramCredentialManager())
  let listener: InstagramListenerShape | null = null
  let selfUserId: string | null = null
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createInstagramChannelResolver({ client, logger })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver
      .resolve({ adapter: 'instagram', workspace, chat, thread: null })
      .catch(() => ({}) as ResolvedChannelNames)
    return `bucket=${workspace} chat=${formatLabel(names.chatName, chat)}`
  }

  const historyCallback = createInstagramHistoryCallback({ client, logger, selfUserIdRef: () => selfUserId })
  const outboundCallback = createOutboundCallback({ client, logger, formatChannelTag })

  const processInbound = async (message: InstagramMessageSummary): Promise<void> => {
    inflightInbounds++
    try {
      if (channelResolver.lookupChat(message.thread_id) === null) {
        await channelResolver.refresh()
        if (channelResolver.lookupChat(message.thread_id) === null) {
          channelResolver.ingestProvisional(message.thread_id)
          logger.warn(
            `[instagram] provisional chat=${message.thread_id} message_id=${message.id} bucket=@instagram-group reason=not_in_listChats`,
          )
        }
      }

      const bucket = channelResolver.lookupChat(message.thread_id)?.workspace ?? '@instagram-group'
      const inboundTag = await formatChannelTag(bucket, message.thread_id)
      logger.info(
        `[instagram] inbound message_id=${message.id} author=${message.from} ${inboundTag} type=${message.type} text_len=${(message.text ?? '').length}`,
      )

      const verdict = classifyInbound(message, options.configRef(), {
        selfUserId,
        lookupChat: (id) => channelResolver.lookupChat(id),
        ...(options.selfAliasesRef ? { selfAliases: options.selfAliasesRef() } : {}),
      })
      if (verdict.kind === 'drop') {
        logger.info(`[instagram] dropped message_id=${message.id} reason=${verdict.reason}`)
        return
      }

      logger.info(
        `[instagram] routed message_id=${message.id} ${inboundTag} mention=${verdict.payload.isBotMention} dm=${verdict.payload.isDm}`,
      )
      await options.router.route(verdict.payload)
    } catch (err) {
      logger.error(`[instagram] handleInbound failed: ${describeError(err)}`)
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
        const credentialStore = options.credentialsStore ?? null
        if (credentialStore !== null) {
          const account = await credentialStore.getAccount()
          if (account === null) {
            throw new Error(
              'no Instagram account in secrets.json#channels.instagram (run typeclaw channel add instagram)',
            )
          }
          await client.login(undefined, account.account_id)
        } else {
          await client.login()
        }
      } catch (err) {
        started = false
        logger.error(`[instagram] login failed: ${describeError(err)}`)
        throw err
      }

      try {
        const profile = await client.getProfile()
        selfUserId = profile.user_id
        logger.info(`[instagram] authenticated as ${profile.username} (${profile.user_id})`)
      } catch (err) {
        started = false
        logger.error(`[instagram] getProfile failed: ${describeError(err)}`)
        throw err
      }

      try {
        await channelResolver.refresh()
      } catch (err) {
        logger.warn(`[instagram] initial chat list fetch failed: ${describeError(err)}`)
      }

      const resolved = (options.listenerCtorResolver ?? resolveInstagramListenerCtor)()
      listener = new resolved.ctor(client, { pollInterval: 5_000 })
      logger.info(`[instagram] listener transport=${resolved.transport}`)
      listener.on('connected', ({ userId, transport = 'polling' }) => {
        connected = true
        logger.info(`[instagram] connected (user_id=${userId}, transport=${transport})`)
      })
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[instagram] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[instagram] listener error: ${describeError(err)}`)
      })
      listener.on('message', (message) => {
        void processInbound(message)
      })

      try {
        await listener.start()
      } catch (err) {
        try {
          listener.stop()
        } catch {
          // best-effort cleanup; the start failure is what we surface
        }
        listener = null
        started = false
        logger.error(`[instagram] listener start failed: ${describeError(err)}`)
        throw err
      }

      options.router.registerOutbound('instagram', outboundCallback)
      options.router.registerChannelNameResolver('instagram', channelResolver.resolve)
      options.router.registerHistory('instagram', historyCallback)
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('instagram', outboundCallback)
      options.router.unregisterChannelNameResolver('instagram', channelResolver.resolve)
      options.router.unregisterHistory('instagram', historyCallback)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
      selfUserId = null
      connected = false
    },

    isConnected(): boolean {
      return connected && selfUserId !== null
    },
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

function formatLabel(name: string | undefined, id: string): string {
  if (name === undefined || name === '' || name === id) return id
  return `${name}(${id})`
}
