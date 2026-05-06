// Insulates our code from agent-messenger's strict-mode upstream TS source
// (no `dist/` declarations on npm yet) by re-exporting under a type-augmented
// surface. Runtime uses the real package; TypeScript sees our richer types.
//
// DELETE WHEN: agent-messenger publishes `dist/platforms/discordbot/
// index.d.ts`. Drop this file and import directly from
// 'agent-messenger/discordbot' in adapters/discord-bot.ts.

import { DiscordBotClient as RawClient, DiscordBotListener as RawListener } from 'agent-messenger/discordbot'

export type DiscordMessage = {
  id: string
  channel_id: string
  author: { id: string; username: string }
  content: string
  timestamp: string
  edited_timestamp?: string
  thread_id?: string
}

export type DiscordGatewayMessageCreateEvent = {
  type: 'MESSAGE_CREATE'
  id: string
  channel_id: string
  guild_id?: string
  author: { id: string; username: string; bot?: boolean }
  content: string
  attachments?: DiscordGatewayAttachment[]
  embeds?: DiscordGatewayEmbed[]
  sticker_items?: DiscordGatewayStickerItem[]
  timestamp: string
  edited_timestamp?: string
  mentions?: Array<{ id: string; username: string }>
  mention_everyone?: boolean
  mention_roles?: string[]
  message_reference?: {
    message_id?: string
    channel_id?: string
    guild_id?: string
  }
}

export type DiscordGatewayAttachment = {
  id: string
  filename: string
  url?: string
  content_type?: string
}

export type DiscordGatewayEmbed = {
  type?: string
  title?: string
  description?: string
  url?: string
}

export type DiscordGatewayStickerItem = {
  id: string
  name: string
  format_type?: number
}

export type DiscordBotListenerConnected = {
  user: { id: string; username: string }
  sessionId: string
}

export type DiscordBotListenerEventMap = {
  message_create: [event: DiscordGatewayMessageCreateEvent]
  connected: [info: DiscordBotListenerConnected]
  disconnected: []
  error: [error: Error]
}

export type DiscordFile = {
  id: string
  filename: string
  size: number
  url: string
  content_type?: string
  height?: number
  width?: number
}

export interface DiscordBotClient {
  login(credentials?: { token: string }): Promise<this>
  sendMessage(channelId: string, content: string, options?: { thread_id?: string }): Promise<DiscordMessage>
  uploadFile(channelId: string, filePath: string): Promise<DiscordFile>
}

export interface DiscordBotListener {
  start(): Promise<void>
  stop(): void
  on<K extends keyof DiscordBotListenerEventMap>(
    event: K,
    listener: (...args: DiscordBotListenerEventMap[K]) => void,
  ): this
  off<K extends keyof DiscordBotListenerEventMap>(
    event: K,
    listener: (...args: DiscordBotListenerEventMap[K]) => void,
  ): this
}

export const DiscordBotClient = RawClient as unknown as new () => DiscordBotClient
export const DiscordBotListener = RawListener as unknown as new (
  client: DiscordBotClient,
  options?: { intents?: number },
) => DiscordBotListener

// Mirror of agent-messenger's DiscordIntent bitmask. Re-declared here (rather
// than re-exported from 'agent-messenger/discordbot') to keep this shim the
// single import surface for the SDK — see this file's header comment.
//
// Source: node_modules/agent-messenger/src/platforms/discordbot/types.ts
//   `export const DiscordIntent = { ... }`
// Keep these values in sync if the SDK ever extends the bitmask.
export const DiscordIntent = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  GuildMessageReactions: 1 << 10,
  GuildMessageTyping: 1 << 11,
  DirectMessages: 1 << 12,
  DirectMessageReactions: 1 << 13,
  DirectMessageTyping: 1 << 14,
  MessageContent: 1 << 15, // privileged — must also be enabled in Discord Developer Portal
} as const
