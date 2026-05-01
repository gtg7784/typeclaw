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
  DiscordBotClient,
  DiscordBotListener,
  DiscordIntent,
  type DiscordGatewayMessageCreateEvent,
} from './agent-messenger-shim'
import { createDiscordChannelResolver } from './discord-bot-channel-resolver'
import { classifyInbound, type InboundDropReason } from './discord-bot-classify'

const DISCORD_API_BASE = 'https://discord.com/api/v10'

function formatLabel(name: string | undefined, id: string, prefix = ''): string {
  if (name === undefined || name === '' || name === id) return id
  return `${prefix}${name}(${id})`
}

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

// Discord's typing indicator (`POST /channels/{id}/typing`) is fire-and-
// forget: the indicator expires after ~10s on Discord's side, the router
// re-fires it every 8s while debouncing or generating, and a missed beat just
// gaps the indicator by a few seconds. We bypass the SDK because it doesn't
// expose this endpoint; rate-limit handling is unnecessary here because the
// router caps cadence per-channel at 8s.
export function createTypingCallback(deps: {
  token: string
  configRef: () => ChannelAdapterConfig
  logger: DiscordBotAdapterLogger
  formatChannelTag?: (workspace: string, chat: string) => Promise<string>
}): TypingCallback {
  const { token, configRef, logger, formatChannelTag } = deps
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'discord-bot') return
    const config = configRef()
    if (!isAllowed(config.allow, target.workspace, target.chat)) return
    // Threads are channels in Discord, so the typing endpoint takes the
    // thread id directly when present.
    const channelId = target.thread ?? target.chat
    const tag = formatChannelTag ? await formatChannelTag(target.workspace, channelId) : `channel=${channelId}`
    try {
      const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/typing`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Length': '0' },
      })
      if (!response.ok) {
        logger.warn(`[discord-bot] typing ${tag} status=${response.status}`)
      }
    } catch (err) {
      logger.warn(`[discord-bot] typing ${tag} failed: ${describe(err)}`)
    }
  }
}

export function createDiscordBotAdapter(options: DiscordBotAdapterOptions): DiscordBotAdapter {
  const logger = options.logger ?? consoleLogger
  const client = new DiscordBotClient()
  let listener: DiscordBotListener | null = null
  let botUserId: string | null = null
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createDiscordChannelResolver({ token: options.token })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'discord-bot', workspace, chat, thread: null }).catch(
      () => ({}) as ResolvedChannelNames,
    )
    const workspacePart = workspace === '@dm' ? 'dm' : `guild=${formatLabel(names.workspaceName, workspace)}`
    const chatPart = `channel=${formatLabel(names.chatName, chat)}`
    return `${workspacePart} ${chatPart}`
  }

  const typingCallback = createTypingCallback({
    token: options.token,
    configRef: options.configRef,
    logger,
    formatChannelTag,
  })

  const outboundCallback: OutboundCallback = async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'discord-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const config = options.configRef()
    if (!isAllowed(config.allow, msg.workspace, msg.chat)) {
      logger.warn(`[discord-bot] outbound denied by allow rules: ${msg.workspace}/${msg.chat}`)
      return { ok: false, error: 'denied by allow rules' }
    }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    // Logged before the API call so we can tell from logs whether the agent
    // even tried to reply, vs. tried-and-failed. Mirrors the inbound log
    // contract on the receive side.
    logger.info(`[discord-bot] outbound ${tag} text_len=${msg.text.length}`)
    try {
      const sent = await client.sendMessage(msg.chat, msg.text, msg.thread ? { thread_id: msg.thread } : undefined)
      logger.info(`[discord-bot] sent id=${sent.id} ${tag}`)
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
      // One log line per gateway event is non-negotiable: it's the only way to
      // tell from logs whether the gateway is delivering at all. content_len=0
      // is the smoking gun for a missing MessageContent privileged intent.
      const inboundWorkspace = event.guild_id ?? '@dm'
      const inboundTag = await formatChannelTag(inboundWorkspace, event.channel_id)
      logger.info(
        `[discord-bot] inbound id=${event.id} author=${formatLabel(event.author.username, event.author.id)} ${inboundTag} content_len=${event.content.length}`,
      )

      const verdict = classifyInbound(event, options.configRef(), botUserId)
      if (verdict.kind === 'drop') {
        logger.info(`[discord-bot] dropped id=${event.id} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }

      const routedTag = await formatChannelTag(verdict.payload.workspace, verdict.payload.chat)
      logger.info(
        `[discord-bot] routed id=${event.id} ${routedTag} mention=${verdict.payload.isBotMention} reply=${verdict.payload.replyToBotMessageId !== null}`,
      )
      await options.router.route(verdict.payload)
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
      options.router.registerTyping('discord-bot', typingCallback)
      options.router.registerChannelNameResolver('discord-bot', channelResolver)

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
      options.router.unregisterTyping('discord-bot', typingCallback)
      options.router.unregisterChannelNameResolver('discord-bot', channelResolver)
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Operator hints appended to drop logs. Kept short — full guidance lives in
// docs. The empty_content hint is the highest-leverage one because that
// failure mode is invisible from Discord's side (bot stays green).
function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_content':
      return ' (enable MESSAGE CONTENT INTENT in Discord Developer Portal and restart)'
    case 'not_in_allow_list':
      return ' (extend channels.discord-bot.allow in typeclaw.json to admit this workspace/channel)'
    case 'bot_author':
      return ''
  }
}
