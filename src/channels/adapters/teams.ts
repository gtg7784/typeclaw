import { TeamsClient, TeamsListener } from 'agent-messenger/teams'
import type { TeamsListenerEventMap, TeamsMessage, TeamsUser } from 'agent-messenger/teams'

import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type {
  ChannelHistoryMessage,
  ChannelSelfIdentityResolver,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  OutboundCallback,
  OutboundMessage,
  SendResult,
} from '@/channels/types'
import type { TeamsAccountRecord } from '@/secrets/schema'

import { describeError } from './describe-error'
import { classifyInbound, normalizeTeamsText, type InboundDropReason, type TeamsInboundEvent } from './teams-classify'

// `TeamsChat` is not exported from agent-messenger/teams, so derive its shape
// from the client method that returns it — this stays in lockstep with the SDK
// without depending on a named export the package chose to keep internal.
export type TeamsChatInfo = Awaited<ReturnType<TeamsClient['listChats']>>[number]

export type TeamsAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: TeamsAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type TeamsClientFactory = () => TeamsClient
export type TeamsListenerFactory = (client: TeamsClient) => TeamsListener

export type TeamsCredentialStore = {
  getAccount(id?: string): Promise<TeamsAccountRecord | null>
}

export type TeamsAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: TeamsAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: TeamsCredentialStore
  createClient?: TeamsClientFactory
  createListener?: TeamsListenerFactory
  now?: () => number
}

export type TeamsAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

const CHAT_PREFIX = 'chat:'
const TEAMS_LISTENER_START_TIMEOUT_MS = 20_000

// The Teams user-account SDK has NO self-identity boundary: `testAuth()` returns
// the literal id `'ME'`, while realtime/history authors carry the real MRI from
// `resource.from`. So an id comparison can never recognize the agent's own
// message echoing back over the trouter socket. Instead every successful send
// records a (chat, normalized-text) fingerprint; an inbound that matches a
// recent unconsumed fingerprint in the same chat is treated as the echo of our
// own send and dropped. The author-name / `'ME'` checks are a fast path; the
// short content-only window is the fallback for when the platform does not
// stamp the outbound back with our display name.
const SELF_ECHO_TTL_MS = 2 * 60_000
const SELF_ECHO_CONTENT_ONLY_TTL_MS = 5_000
const MAX_SENT_ECHOES = 200

type SentEcho = { chatId: string; textKey: string; sentAt: number; consumed: boolean }

export function createOutboundCallback(deps: {
  client: Pick<TeamsClient, 'sendChatMessage'>
  logger: TeamsAdapterLogger
  // Reserve the self-echo fingerprint BEFORE the send is awaited and return a
  // rollback. Teams delivers a send back over the listener socket, and that
  // echo can arrive before `sendChatMessage` resolves — reserving after the
  // await would leave a window where the agent's own message routes back in.
  // The rollback drops the reservation if the send ultimately fails.
  reserveEcho?: (chatId: string, text: string) => () => void
}): OutboundCallback {
  const { client, logger } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'teams') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    const text = msg.text ?? ''
    if (text === '') return { ok: false, error: 'message has no text' }
    if (!msg.chat.startsWith(CHAT_PREFIX)) return { ok: false, error: `unsupported Teams chat id: ${msg.chat}` }
    const chatId = msg.chat.slice(CHAT_PREFIX.length)

    logger.info(`[teams] outbound chat=${chatId} text_len=${text.length}`)
    const rollbackEcho = deps.reserveEcho?.(chatId, text)
    try {
      const sent = await client.sendChatMessage(chatId, text)
      logger.info(`[teams] sent id=${sent.id} chat=${chatId}`)
      return { ok: true, messageId: sent.id, messageIds: [sent.id] }
    } catch (err) {
      rollbackEcho?.()
      const message = describeError(err)
      logger.error(`[teams] outbound failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createTeamsHistoryCallback(deps: {
  client: Pick<TeamsClient, 'getChatMessages'>
  logger: TeamsAdapterLogger
  selfIdRef: () => string | null
}): HistoryCallback {
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    if (!args.chat.startsWith(CHAT_PREFIX)) {
      return { ok: false, error: `unsupported Teams chat id: ${args.chat}` }
    }
    const chatId = args.chat.slice(CHAT_PREFIX.length)
    try {
      const messages = await deps.client.getChatMessages(chatId, clampLimit(args.limit, 100))
      const selfId = deps.selfIdRef()
      return { ok: true, messages: messages.map((m) => mapTeamsHistoryMessage(m, selfId)).reverse() }
    } catch (err) {
      const message = describeError(err)
      deps.logger.warn(`[teams] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createTeamsAdapter(options: TeamsAdapterOptions): TeamsAdapter {
  const logger = options.logger ?? consoleLogger
  const now = options.now ?? Date.now
  const createClient = options.createClient ?? (() => new TeamsClient())
  const createListener = options.createListener ?? ((client) => new TeamsListener(client))
  const client = createClient()
  let listener: TeamsListener | null = null
  let self: TeamsUser | null = null
  let chatsById = new Map<string, TeamsChatInfo>()
  let sentEchoes: SentEcho[] = []
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const selfIdentityResolver: ChannelSelfIdentityResolver = () =>
    self !== null ? { id: self.id, username: self.userPrincipalName ?? self.email ?? self.displayName } : null

  const reserveEcho = (chatId: string, text: string): (() => void) => {
    const echo: SentEcho = { chatId, textKey: normalizeTeamsText(text), sentAt: now(), consumed: false }
    sentEchoes.push(echo)
    if (sentEchoes.length > MAX_SENT_ECHOES) sentEchoes = sentEchoes.slice(-MAX_SENT_ECHOES)
    return () => {
      const index = sentEchoes.indexOf(echo)
      if (index !== -1) sentEchoes.splice(index, 1)
    }
  }

  const isSelfEcho = (event: TeamsInboundEvent): boolean => {
    const textKey = normalizeTeamsText(event.content)
    const authorName = event.author.displayName.trim().toLocaleLowerCase()
    const selfName = (self?.displayName ?? '').trim().toLocaleLowerCase()
    const nowMs = now()
    for (const echo of sentEchoes) {
      if (echo.consumed || echo.chatId !== event.chatId || echo.textKey !== textKey) continue
      const age = nowMs - echo.sentAt
      if (age > SELF_ECHO_TTL_MS) continue
      const authorLooksSelf =
        event.author.id === 'ME' || (selfName !== '' && authorName === selfName) || authorName === 'me'
      if (authorLooksSelf || age <= SELF_ECHO_CONTENT_ONLY_TTL_MS) {
        echo.consumed = true
        return true
      }
    }
    return false
  }

  const outboundCallback = createOutboundCallback({ client, logger, reserveEcho })
  const historyCallback = createTeamsHistoryCallback({ client, logger, selfIdRef: () => self?.id ?? null })

  const refreshChats = async (): Promise<void> => {
    const chats = await client.listChats()
    chatsById = new Map(chats.map((chat) => [chat.id, chat]))
  }

  const resolveChat = async (chatId: string): Promise<TeamsChatInfo | undefined> => {
    const cached = chatsById.get(chatId)
    if (cached !== undefined) return cached
    try {
      await refreshChats()
    } catch (err) {
      logger.warn(`[teams] chat refresh failed: ${describeError(err)}`)
    }
    return chatsById.get(chatId)
  }

  const handleMessage = async (event: TeamsInboundEvent): Promise<void> => {
    inflightInbounds++
    try {
      if (isSelfEcho(event)) {
        logger.info(`[teams] dropped id=${event.id} reason=self_echo`)
        return
      }
      const chat = await resolveChat(event.chatId)
      const verdict = classifyInbound(event, options.configRef(), self, chat, options.selfAliasesRef?.() ?? [])
      if (verdict.kind === 'drop') {
        logger.info(`[teams] dropped id=${event.id} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }
      logger.info(
        `[teams] routed id=${event.id} chat=${event.chatId} mention=${verdict.payload.isBotMention} dm=${verdict.payload.isDm}`,
      )
      await options.router.route(verdict.payload)
    } catch (err) {
      logger.error(`[teams] handleInbound failed: ${describeError(err)}`)
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
        const account = await (options.credentialsStore ?? null)?.getAccount()
        if (account === null || account === undefined) {
          throw new Error('no Teams account in secrets.json#channels.teams (run typeclaw init to authenticate)')
        }
        warnIfTokenExpiring(account, logger, now())
        await client.login({
          token: account.access_token,
          ...(account.token_expires_at !== undefined ? { tokenExpiresAt: account.token_expires_at } : {}),
          accountType: account.account_type,
          ...(account.region !== undefined ? { region: account.region } : {}),
        })
        self = await client.testAuth()
        await refreshChats()
        logger.info(`[teams] authenticated as ${self.displayName}, ${chatsById.size} chats`)
      } catch (err) {
        started = false
        self = null
        chatsById = new Map()
        logger.error(`[teams] login failed: ${describeError(err)}`)
        throw err
      }

      listener = createListener(client)
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[teams] disconnected')
      })
      listener.on('error', (err: TeamsListenerEventMap['error'][0]) => {
        logger.error(`[teams] listener error: ${describeError(err)}`)
      })
      listener.on('message', (event: TeamsListenerEventMap['message'][0]) => {
        void handleMessage(event)
      })

      options.router.registerOutbound('teams', outboundCallback)
      options.router.registerSelfIdentity('teams', selfIdentityResolver)
      options.router.registerHistory('teams', historyCallback)

      const rollbackStart = (reason: string, cause: Error): never => {
        options.router.unregisterOutbound('teams', outboundCallback)
        options.router.unregisterSelfIdentity('teams', selfIdentityResolver)
        options.router.unregisterHistory('teams', historyCallback)
        listener?.stop()
        listener = null
        self = null
        chatsById = new Map()
        sentEchoes = []
        connected = false
        started = false
        logger.error(`[teams] ${reason}: ${describeError(cause)}`)
        throw cause
      }

      // The SDK emits `connected` asynchronously, only after the trouter
      // WebSocket registers an endpoint — it is NOT raised synchronously by
      // `listener.start()`. So attach the connected/error race BEFORE start()
      // and await it, rather than sampling a flag right after start() returns.
      const connectedWait = waitForTeamsConnected(listener)
      try {
        await listener.start()
        await connectedWait.promise
        connected = true
      } catch (err) {
        // Tear down the connected wait first: if `listener.start()` itself
        // rejected, `connectedWait.promise` was never awaited, so its timer and
        // handlers would otherwise linger and reject later unhandled.
        connectedWait.cancel()
        rollbackStart('listener start failed', err instanceof Error ? err : new Error(describeError(err)))
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('teams', outboundCallback)
      options.router.unregisterSelfIdentity('teams', selfIdentityResolver)
      options.router.unregisterHistory('teams', historyCallback)
      listener?.stop()
      listener = null
      connected = false
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      self = null
      chatsById = new Map()
      sentEchoes = []
    },

    isConnected(): boolean {
      return started && self !== null && connected
    },
  }
}

// Returns the connected/error/timeout race plus a `cancel` that tears down the
// timer and listener handlers. `cancel` is load-bearing: if `listener.start()`
// itself rejects, the caller never awaits `promise`, so without cancellation
// the 20s timer would linger and the promise could later reject with no handler
// (an unhandled rejection). Cancelling resolves the promise as a no-op so it
// stays handled.
function waitForTeamsConnected(
  listener: TeamsListener,
  timeoutMs = TEAMS_LISTENER_START_TIMEOUT_MS,
): { promise: Promise<void>; cancel: () => void } {
  let settled = false
  let onConnected: () => void = () => {}
  let onError: (err: Error) => void = () => {}
  let resolveNoop: () => void = () => {}
  let timer: ReturnType<typeof setTimeout>
  const cleanup = (): void => {
    clearTimeout(timer)
    listener.off('connected', onConnected)
    listener.off('error', onError)
  }
  const promise = new Promise<void>((resolve, reject) => {
    resolveNoop = resolve
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    onConnected = (): void => settle(resolve)
    onError = (err: Error): void => settle(() => reject(err))
    timer = setTimeout(
      () => settle(() => reject(new Error(`Teams listener did not connect within ${timeoutMs}ms`))),
      timeoutMs,
    )
    listener.on('connected', onConnected)
    listener.on('error', onError)
  })
  const cancel = (): void => {
    if (settled) return
    settled = true
    cleanup()
    resolveNoop()
  }
  return { promise, cancel }
}

// `getChatMessages` already strips HTML and sets `author.id` to the real MRI
// (never `'ME'`), so bot-authored history can only be recognized when the
// caller happens to know that MRI — which the SDK does not surface. `selfId`
// is therefore best-effort: it flags nothing in practice today, but leaving the
// comparison in place means history attribution starts working for free if a
// future SDK version exposes the real self id.
function mapTeamsHistoryMessage(msg: TeamsMessage, selfId: string | null): ChannelHistoryMessage {
  const ts = Date.parse(msg.timestamp)
  return {
    externalMessageId: msg.id,
    authorId: msg.author.id,
    authorName: msg.author.displayName,
    text: msg.content,
    ts: Number.isFinite(ts) ? ts : 0,
    isBot: selfId !== null && msg.author.id === selfId,
    replyToBotMessageId: null,
  }
}

function warnIfTokenExpiring(account: TeamsAccountRecord, logger: TeamsAdapterLogger, nowMs: number): void {
  if (account.token_expires_at === undefined) return
  const expiresAt = Date.parse(account.token_expires_at)
  if (!Number.isFinite(expiresAt)) return
  if (expiresAt <= nowMs) {
    logger.warn('[teams] access token is already expired; the adapter will fail until credentials are refreshed')
  } else if (expiresAt - nowMs <= 10 * 60_000) {
    logger.warn('[teams] access token expires soon; long-running sessions will stop until credentials are refreshed')
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_content':
      return ' (message had no text)'
    case 'unknown_chat':
      return ' (chat id not found even after refresh)'
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}
