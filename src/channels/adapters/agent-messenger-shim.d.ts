// Insulates our typecheck from agent-messenger's TS source (no `dist/`
// shipped on npm yet). Bun resolves the real package at runtime; tsconfig
// `paths` redirects TypeScript here instead.
//
// DELETE WHEN: agent-messenger publishes `dist/platforms/discordbot/
// index.d.ts`. Drop this file and the tsconfig `paths` entry together.

declare module 'agent-messenger/discordbot' {
  export interface DiscordMessage {
    id: string
    channel_id: string
    author: { id: string; username: string }
    content: string
    timestamp: string
    edited_timestamp?: string
    thread_id?: string
  }

  export interface DiscordGatewayMessageCreateEvent {
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

  export interface DiscordBotListenerEventMap {
    message_create: [event: DiscordGatewayMessageCreateEvent]
    connected: [info: DiscordBotListenerConnected]
    disconnected: []
    error: [error: Error]
    [event: string]: unknown[]
  }

  export class DiscordBotClient {
    login(credentials?: { token: string }): Promise<this>
    sendMessage(
      channelId: string,
      content: string,
      options?: { thread_id?: string },
    ): Promise<DiscordMessage>
  }

  export class DiscordBotListener {
    constructor(client: DiscordBotClient, options?: { intents?: number })
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
}
