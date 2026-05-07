// Insulates our code from agent-messenger's strict-mode upstream TS source
// (no `dist/` declarations on npm yet) by re-exporting under a type-augmented
// surface. Runtime uses the real package; TypeScript sees our richer types.
//
// DELETE WHEN: agent-messenger publishes `dist/platforms/slackbot/
// index.d.ts`. Drop this file and import directly from
// 'agent-messenger/slackbot' in adapters/slack-bot.ts.
//
// We also extend `postMessage` to accept Slack `blocks`, which the upstream
// signature does not expose. The blocks path bypasses the upstream method
// and reaches the underlying `@slack/web-api` `WebClient` via the upstream
// instance's private `client` field — fragile, but isolated to one method
// here. The alternative was either taking a direct `@slack/web-api`
// dependency (currently transitive) or upstreaming a PR; both are heavier
// than this localized cast.

import { SlackBotClient as RawClient, SlackBotListener as RawListener } from 'agent-messenger/slackbot'

export type SlackPostedMessage = {
  ts: string
  text: string
  user?: string
  username?: string
  type: string
  thread_ts?: string
}

export type SlackTestAuth = {
  user_id: string
  team_id: string
  bot_id?: string
  user?: string
  team?: string
}

export type SlackSocketMessageEvent = {
  type: 'message'
  subtype?: string
  channel: string
  channel_type?: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  // Slack populates this on every reply within a thread and sets it to the
  // user id of the message that started the thread (i.e. the author of
  // `thread_ts`). Absent on top-level messages and on the thread root
  // itself. The classifier uses it to decide whether a reply is a reply to
  // *us* (the bot) — the `event` payload alone otherwise has no way to
  // know who authored the parent.
  parent_user_id?: string
  event_ts?: string
  edited?: { user: string; ts: string }
  hidden?: boolean
  // Client-generated UUID present on user-authored messages. Stable across
  // network retries of the same user gesture (the Slack client reuses it
  // when a send fails and is retried), so it is a reliable secondary dedup
  // key for the case where one user action surfaces as two events with
  // different `ts` values. Absent on bot messages and most system events.
  client_msg_id?: string
  // Files uploaded by the user alongside (or in lieu of) text. Slack
  // delivers file metadata on the same `message` event — there is no
  // separate `file_share` event for messages we receive. Surfaced as a
  // typed field (rather than relying on the catchall below) so the
  // classifier can read it without `as` casts and so adapters can hand
  // file ids to the SDK's downloadFile API for fetching.
  files?: SlackFile[]
  [key: string]: unknown
}

export type SlackSocketAppMentionEvent = {
  type: 'app_mention'
  channel: string
  user: string
  text: string
  ts: string
  thread_ts?: string
  event_ts?: string
  // Carried verbatim into the promoted message event when present so the
  // dedupe ring can use it. Slack's `app_mention` envelope does not always
  // populate this in practice, but typing it keeps the promotion lossless
  // if Slack starts sending it.
  client_msg_id?: string
  [key: string]: unknown
}

export type SlackSocketAck = (responsePayload?: Record<string, unknown>) => void

export type SlackSocketEventsApiEnvelope<E> = {
  ack: SlackSocketAck
  envelope_id: string
  body: {
    team_id?: string
    api_app_id?: string
    event: E
    event_id?: string
    event_time?: number
    [key: string]: unknown
  }
  event: E
}

export type SlackBotListenerConnected = {
  app_id?: string
  num_connections?: number
}

export type SlackBotListenerEventMap = {
  message: [args: SlackSocketEventsApiEnvelope<SlackSocketMessageEvent>]
  app_mention: [args: SlackSocketEventsApiEnvelope<SlackSocketAppMentionEvent>]
  connected: [info: SlackBotListenerConnected]
  disconnected: []
  error: [error: Error]
}

export type SlackFile = {
  id: string
  name: string
  title: string
  mimetype: string
  size: number
  url_private: string
  created: number
  user: string
  channels?: string[]
}

// `blocks` is opaque to us; we just forward it. Slack's API accepts any
// JSON-shaped block array — typing it as unknown[] avoids importing
// @slack/types and keeps the shim's external surface small.
export type SlackPostMessageOptions = {
  thread_ts?: string
  blocks?: unknown[]
}

export interface SlackBotClient {
  login(credentials?: { token: string }): Promise<this>
  testAuth(): Promise<SlackTestAuth>
  postMessage(channel: string, text: string, options?: SlackPostMessageOptions): Promise<SlackPostedMessage>
  setAssistantStatus(channel: string, threadTs: string, status: string): Promise<void>
  uploadFile(
    channel: string,
    file: Buffer,
    filename: string,
    options?: { thread_ts?: string; title?: string; initial_comment?: string },
  ): Promise<SlackFile>
  downloadFile(fileId: string): Promise<{ buffer: Buffer; file: SlackFile }>
}

export interface SlackBotListener {
  start(): Promise<void>
  stop(): void
  on<K extends keyof SlackBotListenerEventMap>(event: K, listener: (...args: SlackBotListenerEventMap[K]) => void): this
  off<K extends keyof SlackBotListenerEventMap>(
    event: K,
    listener: (...args: SlackBotListenerEventMap[K]) => void,
  ): this
}

// Subclass that overrides `postMessage` to support blocks. When blocks are
// supplied, we bypass the upstream method (which doesn't forward blocks)
// and call the underlying @slack/web-api WebClient.chat.postMessage
// directly via the private `client` field. Without blocks, we delegate to
// the upstream method to inherit its retry-on-rate-limit behavior.
class ExtendedSlackBotClient extends (RawClient as unknown as new () => SlackBotClient) {
  override async postMessage(
    channel: string,
    text: string,
    options?: SlackPostMessageOptions,
  ): Promise<SlackPostedMessage> {
    if (options?.blocks === undefined) {
      const passthrough = options?.thread_ts !== undefined ? { thread_ts: options.thread_ts } : undefined
      return await super.postMessage(channel, text, passthrough)
    }

    type RawWebClient = {
      chat: {
        postMessage: (args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }) => Promise<{
          ok?: boolean
          error?: string
          ts?: string
          message?: { text?: string; type?: string; user?: string; thread_ts?: string }
        }>
      }
    }
    const raw = this as unknown as { client: RawWebClient | null }
    if (raw.client === null) {
      throw new Error('SlackBotClient.postMessage with blocks: not authenticated')
    }
    const args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] } = {
      channel,
      text,
      blocks: options.blocks,
    }
    if (options.thread_ts !== undefined) args.thread_ts = options.thread_ts
    const response = await raw.client.chat.postMessage(args)
    if (response.ok !== true) {
      throw new Error(response.error ?? 'slack postMessage with blocks failed')
    }
    const msg = response.message
    return {
      ts: response.ts ?? '',
      text: msg?.text ?? text,
      type: msg?.type ?? 'message',
      ...(msg?.user !== undefined ? { user: msg.user } : {}),
      ...(msg?.thread_ts !== undefined ? { thread_ts: msg.thread_ts } : {}),
    }
  }
}

export const SlackBotClient = ExtendedSlackBotClient as unknown as new () => SlackBotClient
export const SlackBotListener = RawListener as unknown as new (
  client: SlackBotClient,
  options: { appToken: string; debugReconnects?: boolean },
) => SlackBotListener
