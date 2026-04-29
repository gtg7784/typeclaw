import type { ChannelRouter } from '@/channels/router'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { OutboundCallback, OutboundMessage, SendResult } from '@/channels/types'

import {
  DiscordBotClient,
  DiscordBotListener,
  DiscordIntent,
  type DiscordGatewayMessageCreateEvent,
} from './agent-messenger-shim'

const TYPING_INTERVAL_MS = 8000

// agent-messenger's DEFAULT_INTENTS omits MessageContent (privileged), so the
// bot's gateway IDENTIFY never asks for it and Discord delivers every message
// with content: ''. We mirror the SDK's defaults here and add MessageContent
// so inbound messages actually carry text. The portal toggle is necessary but
// not sufficient — the bitmask must include this bit too.
export const DISCORD_BOT_INTENTS =
  DiscordIntent.Guilds |
  DiscordIntent.GuildMessages |
  DiscordIntent.GuildMessageReactions |
  DiscordIntent.GuildMessageTyping |
  DiscordIntent.DirectMessages |
  DiscordIntent.DirectMessageReactions |
  DiscordIntent.DirectMessageTyping |
  DiscordIntent.MessageContent

export type DiscordBotAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: DiscordBotAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type DiscordBotAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  token: string
  logger?: DiscordBotAdapterLogger
}

export type DiscordBotAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export function createDiscordBotAdapter(options: DiscordBotAdapterOptions): DiscordBotAdapter {
  const logger = options.logger ?? consoleLogger
  const client = new DiscordBotClient()
  let listener: DiscordBotListener | null = null
  let botUserId: string | null = null
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const outboundCallback: OutboundCallback = async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'discord-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const config = options.configRef()
    if (!isAllowed(config.allow, msg.workspace, msg.chat)) {
      logger.warn(`[discord-bot] outbound denied by allow rules: ${msg.workspace}/${msg.chat}`)
      return { ok: false, error: 'denied by allow rules' }
    }
    try {
      await client.sendMessage(msg.chat, msg.text, msg.thread ? { thread_id: msg.thread } : undefined)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[discord-bot] sendMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }

  const handleMessageCreate = async (event: DiscordGatewayMessageCreateEvent): Promise<void> => {
    inflightInbounds++
    try {
      // Bot-authored messages are dropped at the source to prevent echo loops.
      if (event.author.bot === true) return
      // Privileged MessageContent intent is required to receive content; without
      // it the SDK delivers events with content: ''.
      if (event.content === '') return

      const config = options.configRef()
      const isDm = event.guild_id === undefined
      const workspace = isDm ? '@dm' : event.guild_id!
      if (!isAllowed(config.allow, workspace, event.channel_id)) return

      const isBotMention =
        botUserId !== null
          ? event.content.includes(`<@${botUserId}>`) || event.content.includes(`<@!${botUserId}>`)
          : true
      const replyToBotMessageId =
        event.message_reference?.message_id !== undefined && botUserId !== null
          ? event.message_reference.message_id
          : null

      await options.router.route({
        adapter: 'discord-bot',
        workspace,
        chat: event.channel_id,
        thread: null,
        text: event.content,
        externalMessageId: event.id,
        authorId: event.author.id,
        authorName: event.author.username,
        isBotMention,
        replyToBotMessageId,
        isDm,
      })
    } catch (err) {
      logger.error(`[discord-bot] handleInbound failed: ${describe(err)}`)
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
        logger.error(`[discord-bot] login failed: ${describe(err)}`)
        throw err
      }

      listener = new DiscordBotListener(client, { intents: DISCORD_BOT_INTENTS })
      listener.on('connected', (info) => {
        botUserId = info.user.id
        logger.info(`[discord-bot] connected as ${info.user.username} (${info.user.id})`)
      })
      listener.on('disconnected', () => {
        logger.warn('[discord-bot] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[discord-bot] gateway error: ${describe(err)}`)
      })
      listener.on('message_create', (event) => {
        void handleMessageCreate(event)
      })

      options.router.registerOutbound('discord-bot', outboundCallback)

      try {
        await listener.start()
      } catch (err) {
        started = false
        logger.error(`[discord-bot] listener start failed: ${describe(err)}`)
        throw err
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('discord-bot', outboundCallback)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
    },

    isConnected(): boolean {
      return botUserId !== null
    },
  }
}

export const TYPING_HEARTBEAT_MS = TYPING_INTERVAL_MS

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
