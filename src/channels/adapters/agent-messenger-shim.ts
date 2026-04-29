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
  timestamp: string
  edited_timestamp?: string
  mentions?: Array<{ id: string; username: string }>
  message_reference?: {
    message_id?: string
    channel_id?: string
    guild_id?: string
  }
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

export interface DiscordBotClient {
  login(credentials?: { token: string }): Promise<this>
  sendMessage(channelId: string, content: string, options?: { thread_id?: string }): Promise<DiscordMessage>
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
