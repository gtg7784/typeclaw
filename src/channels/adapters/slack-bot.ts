import type { ChannelRouter } from '@/channels/router'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { OutboundCallback, OutboundMessage, SendResult, TypingCallback, TypingTarget } from '@/channels/types'

import { SlackBotClient, SlackBotListener, type SlackSocketMessageEvent } from './agent-messenger-slack-shim'
import { classifyInbound, type InboundDropReason } from './slack-bot-classify'

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

// Slack typing indicators inside Socket Mode are advertised under the
// `assistant.threads.setStatus` Web API, which only works for the AI Agents
// & Assistants beta. For the general bot path there is no public typing
// endpoint, so we make the typing callback a no-op rather than spamming
// channel.history with placeholder messages. This is consistent with how
// most production Slack bots behave (no visible typing dot) and keeps the
// router's typing heartbeat from generating warning noise.
export function createTypingCallback(deps: {
  configRef: () => ChannelAdapterConfig
  logger: SlackBotAdapterLogger
}): TypingCallback {
  const { configRef, logger } = deps
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'slack-bot') return
    const config = configRef()
    if (!isAllowed(config.allow, target.workspace, target.chat)) return
    logger.info(`[slack-bot] typing (no-op) channel=${target.thread ?? target.chat}`)
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

  const typingCallback = createTypingCallback({ configRef: options.configRef, logger })

  const outboundCallback: OutboundCallback = async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'slack-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const config = options.configRef()
    if (!isAllowed(config.allow, msg.workspace, msg.chat)) {
      logger.warn(`[slack-bot] outbound denied by allow rules: ${msg.workspace}/${msg.chat}`)
      return { ok: false, error: 'denied by allow rules' }
    }
    logger.info(`[slack-bot] outbound workspace=${msg.workspace} chat=${msg.chat} text_len=${msg.text.length}`)
    try {
      const sent = await client.postMessage(
        msg.chat,
        msg.text,
        msg.thread !== undefined && msg.thread !== null ? { thread_ts: msg.thread } : undefined,
      )
      logger.info(`[slack-bot] sent ts=${sent.ts} chat=${msg.chat}`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[slack-bot] postMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }

  const handleMessageEvent = async (event: SlackSocketMessageEvent): Promise<void> => {
    inflightInbounds++
    try {
      const where = event.channel_type === 'im' ? 'dm' : `team=${teamId ?? 'unknown'}`
      const text = event.text ?? ''
      logger.info(
        `[slack-bot] inbound ts=${event.ts} user=${event.user ?? 'unknown'} ${where} channel=${event.channel} text_len=${text.length}`,
      )

      if (teamId === null) {
        logger.warn(`[slack-bot] dropped ts=${event.ts} reason=pre_connected (team_id unknown)`)
        return
      }

      const verdict = classifyInbound(event, options.configRef(), { teamId, botUserId })
      if (verdict.kind === 'drop') {
        logger.info(`[slack-bot] dropped ts=${event.ts} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }

      logger.info(
        `[slack-bot] routed ts=${event.ts} workspace=${verdict.payload.workspace} mention=${verdict.payload.isBotMention} reply=${verdict.payload.replyToBotMessageId !== null}`,
      )
      await options.router.route(verdict.payload)
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
        void handleMessageEvent(event)
      })
      // app_mention is a separate event type from message; channel mentions
      // arrive on both with overlapping payloads, so we route mentions
      // through the same handler shape (synthesizing a message-shaped event
      // would be brittle). The classifier already detects mentions inside
      // text, so handling them via the `message` listener is sufficient for
      // the route/drop verdict. We still ack the envelope to silence retries.
      listener.on('app_mention', ({ ack }) => {
        ack()
      })

      options.router.registerOutbound('slack-bot', outboundCallback)
      options.router.registerTyping('slack-bot', typingCallback)

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
