import type { ChannelRouter } from '@/channels/router'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type {
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
  TypingCallback,
  TypingTarget,
} from '@/channels/types'

import {
  SlackBotClient,
  SlackBotListener,
  type SlackSocketAppMentionEvent,
  type SlackSocketMessageEvent,
} from './agent-messenger-slack-shim'
import { createSlackAuthorResolver } from './slack-bot-author-resolver'
import { createSlackChannelResolver } from './slack-bot-channel-resolver'
import { classifyInbound, type InboundDropReason } from './slack-bot-classify'

// Bound on the dedupe ring buffer. Slack's Events API may deliver the same
// channel mention twice — once as `message` (when the bot has channel
// history scope and is a member) and once as `app_mention` — and the two
// envelopes share the same `ts`. The buffer only needs to cover the gap
// between the two deliveries; a few hundred is generous.
const SEEN_TS_CAPACITY = 256

// Resolvers fall back to the raw id on failure, so a name equal to the id
// means resolution failed; we render the bare id rather than `id(id)`. The
// prefix is intentionally only applied to the named form so we never log
// `#C0DEPLOY` when resolution fails.
function formatLabel(name: string | undefined, id: string, prefix = ''): string {
  if (name === undefined || name === '' || name === id) return id
  return `${prefix}${name}(${id})`
}

// app_mention payloads omit channel_type and never carry a subtype, so we
// promote them to a message-shaped event for the shared classifier. The
// promoted event is classified as a regular channel message; the
// `<@BOT_USER_ID>` substring inside `text` is what makes the classifier
// mark it as a mention.
export function promoteAppMentionToMessage(event: SlackSocketAppMentionEvent): SlackSocketMessageEvent {
  return {
    type: 'message',
    channel: event.channel,
    channel_type: 'channel',
    user: event.user,
    text: event.text,
    ts: event.ts,
    ...(event.thread_ts !== undefined ? { thread_ts: event.thread_ts } : {}),
    ...(event.event_ts !== undefined ? { event_ts: event.event_ts } : {}),
  }
}

export type SlackBotAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: SlackBotAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type SlackBotAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  token: string
  appToken: string
  logger?: SlackBotAdapterLogger
}

export type SlackBotAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

// Slack's only bot-accessible typing-style signal is `assistant.threads.
// setStatus`, which is scoped to AI Assistant threads and requires a
// `thread_ts`. The classic `user_typing` is RTM-only and rejects bot
// tokens, so there is nothing to send for top-level (non-threaded) chats —
// we log and bail in that case. Slack auto-clears the status when the bot
// posts its reply, so we only set; we never explicitly clear.
//
// The router fires this on a heartbeat (~every few seconds while
// debouncing/generating). Slack rejects calls in non-Assistant channels
// with `channel_not_found` / `not_in_channel`-style errors; we surface
// those as a single warn line per heartbeat (matching the Discord
// adapter's non-2xx handling) rather than escalating to error, because
// the bot may simply be deployed in a regular channel.
export function createTypingCallback(deps: {
  client: Pick<SlackBotClient, 'setAssistantStatus'>
  configRef: () => ChannelAdapterConfig
  logger: SlackBotAdapterLogger
  formatChannelTag?: (workspace: string, chat: string) => Promise<string>
}): TypingCallback {
  const { client, configRef, logger, formatChannelTag } = deps
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'slack-bot') return
    const config = configRef()
    if (!isAllowed(config.allow, target.workspace, target.chat)) return
    const tag = formatChannelTag
      ? await formatChannelTag(target.workspace, target.thread ?? target.chat)
      : `channel=${target.thread ?? target.chat}`
    if (target.thread === undefined || target.thread === null || target.thread === '') {
      logger.info(`[slack-bot] typing (no-op, top-level chat) ${tag}`)
      return
    }
    try {
      await client.setAssistantStatus(target.chat, target.thread, 'is typing...')
    } catch (err) {
      logger.warn(`[slack-bot] typing ${tag} failed: ${describe(err)}`)
    }
  }
}

export function createSlackBotAdapter(options: SlackBotAdapterOptions): SlackBotAdapter {
  const logger = options.logger ?? consoleLogger
  const client = new SlackBotClient()
  let listener: SlackBotListener | null = null
  let botUserId: string | null = null
  let teamId: string | null = null
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const authorResolver = createSlackAuthorResolver({ token: options.token })
  const channelResolver = createSlackChannelResolver({ token: options.token })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'slack-bot', workspace, chat, thread: null }).catch(
      () => ({}) as ResolvedChannelNames,
    )
    const workspacePart = workspace === '@dm' ? 'dm' : `team=${formatLabel(names.workspaceName, workspace)}`
    const chatPart = `channel=${formatLabel(names.chatName, chat, '#')}`
    return `${workspacePart} ${chatPart}`
  }

  const typingCallback = createTypingCallback({ client, configRef: options.configRef, logger, formatChannelTag })

  const outboundCallback: OutboundCallback = async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'slack-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const config = options.configRef()
    if (!isAllowed(config.allow, msg.workspace, msg.chat)) {
      logger.warn(`[slack-bot] outbound denied by allow rules: ${msg.workspace}/${msg.chat}`)
      return { ok: false, error: 'denied by allow rules' }
    }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(`[slack-bot] outbound ${tag} text_len=${msg.text.length}`)
    try {
      const sent = await client.postMessage(
        msg.chat,
        msg.text,
        msg.thread !== undefined && msg.thread !== null ? { thread_ts: msg.thread } : undefined,
      )
      logger.info(`[slack-bot] sent ts=${sent.ts} ${tag}`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[slack-bot] postMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }

  // Bounded set of "channel:ts" keys we've already routed, used to dedupe
  // the message/app_mention double-delivery. Insertion-ordered Set lets us
  // evict the oldest entry when we hit the cap.
  const seenTs = new Set<string>()
  const markSeen = (key: string): void => {
    if (seenTs.has(key)) return
    if (seenTs.size >= SEEN_TS_CAPACITY) {
      const oldest = seenTs.values().next().value
      if (oldest !== undefined) seenTs.delete(oldest)
    }
    seenTs.add(key)
  }

  const handleMessageEvent = async (
    event: SlackSocketMessageEvent,
    source: 'message' | 'app_mention',
  ): Promise<void> => {
    inflightInbounds++
    try {
      const text = event.text ?? ''
      const dedupeKey = `${event.channel}:${event.ts}`
      const userId = event.user ?? 'unknown'
      const inboundWorkspace = event.channel_type === 'im' ? '@dm' : (teamId ?? 'unknown')
      const [resolvedUserName, inboundTag] = await Promise.all([
        event.user !== undefined && event.user !== '' ? authorResolver.resolve(event.user) : Promise.resolve(userId),
        formatChannelTag(inboundWorkspace, event.channel),
      ])
      logger.info(
        `[slack-bot] inbound source=${source} ts=${event.ts} user=${formatLabel(resolvedUserName, userId)} ${inboundTag} text_len=${text.length}`,
      )

      if (teamId === null) {
        logger.warn(`[slack-bot] dropped ts=${event.ts} reason=pre_connected (team_id unknown)`)
        return
      }

      if (seenTs.has(dedupeKey)) {
        logger.info(`[slack-bot] dropped ts=${event.ts} reason=duplicate_delivery (source=${source})`)
        return
      }

      const verdict = classifyInbound(event, options.configRef(), { teamId, botUserId })
      if (verdict.kind === 'drop') {
        logger.info(`[slack-bot] dropped ts=${event.ts} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }

      markSeen(dedupeKey)
      const enriched = { ...verdict.payload, authorName: resolvedUserName }
      const routedTag = await formatChannelTag(enriched.workspace, enriched.chat)
      logger.info(
        `[slack-bot] routed ts=${event.ts} ${routedTag} mention=${enriched.isBotMention} reply=${enriched.replyToBotMessageId !== null}`,
      )
      await options.router.route(enriched)
    } catch (err) {
      logger.error(`[slack-bot] handleInbound failed: ${describe(err)}`)
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
        logger.error(`[slack-bot] login failed: ${describe(err)}`)
        throw err
      }

      // auth.test resolves the bot's identity and team. We need both: teamId
      // becomes the `workspace` field on every inbound, and botUserId is how
      // we recognize self-authored messages and mentions. Failure here is
      // fatal — without these we can't classify anything correctly.
      try {
        const auth = await client.testAuth()
        botUserId = auth.user_id
        teamId = auth.team_id
        logger.info(`[slack-bot] authenticated as ${auth.user ?? auth.user_id} in team ${auth.team ?? auth.team_id}`)
      } catch (err) {
        started = false
        logger.error(`[slack-bot] auth.test failed: ${describe(err)}`)
        throw err
      }

      listener = new SlackBotListener(client, { appToken: options.appToken })
      listener.on('connected', (info) => {
        logger.info(`[slack-bot] connected (app_id=${info.app_id ?? 'unknown'})`)
      })
      listener.on('disconnected', () => {
        logger.warn('[slack-bot] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[slack-bot] socket-mode error: ${describe(err)}`)
      })
      listener.on('message', ({ ack, event }) => {
        // Ack first so Slack stops retrying; failure to ack causes duplicate
        // deliveries within seconds. Then process asynchronously.
        ack()
        void handleMessageEvent(event, 'message')
      })
      // app_mention is required for mentions in channels where the bot is
      // NOT a member: in that case Slack does not fire a `message` event
      // (it requires `*:history` scope + membership), only `app_mention`
      // (which only requires `app_mentions:read`). The dedupe ring buffer
      // collapses the in-channel double-delivery when both events fire.
      listener.on('app_mention', ({ ack, event }) => {
        ack()
        void handleMessageEvent(promoteAppMentionToMessage(event), 'app_mention')
      })

      options.router.registerOutbound('slack-bot', outboundCallback)
      options.router.registerTyping('slack-bot', typingCallback)
      options.router.registerChannelNameResolver('slack-bot', channelResolver)

      try {
        await listener.start()
      } catch (err) {
        started = false
        logger.error(`[slack-bot] listener start failed: ${describe(err)}`)
        throw err
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('slack-bot', outboundCallback)
      options.router.unregisterTyping('slack-bot', typingCallback)
      options.router.unregisterChannelNameResolver('slack-bot', channelResolver)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
      botUserId = null
      teamId = null
    },

    isConnected(): boolean {
      return botUserId !== null && teamId !== null
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Operator hints appended to drop logs. Kept short — full guidance lives in
// docs. The not_in_allow_list hint is the highest-leverage one because that
// failure mode is invisible from Slack's side (bot stays online).
function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'not_in_allow_list':
      return ' (extend channels.slack-bot.allow in typeclaw.json to admit this team/channel)'
    case 'empty_text':
    case 'no_user':
    case 'bot_author':
      return ''
  }
}
