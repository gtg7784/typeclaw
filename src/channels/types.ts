import type { AdapterId } from './schema'

export type ChannelKey = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type InboundMessage = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  text: string
  externalMessageId: string
  authorId: string
  authorName: string
  // Set true when the inbound is from another bot (NOT this typeclaw
  // instance's own bot identity — the adapter still drops self-authored
  // messages with `reason: 'self_author'`). The router treats peer bots
  // identically to humans for engagement, but uses this flag to drive a
  // bounded loop guard so two or more bots cannot ping-pong forever.
  authorIsBot: boolean
  isBotMention: boolean
  replyToBotMessageId: string | null
  isDm: boolean
}

export type OutboundMessage = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
  text: string
}

export type SendResult = { ok: true } | { ok: false; error: string }

export type OutboundCallback = (msg: OutboundMessage) => Promise<SendResult>

export type TypingTarget = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
}

export type TypingCallback = (target: TypingTarget) => Promise<void>

export type ResolvedChannelNames = {
  chatName?: string
  workspaceName?: string
}

export type ChannelNameResolver = (key: ChannelKey) => Promise<ResolvedChannelNames>

// History entries are intentionally distinct from InboundMessage:
// `InboundMessage` carries router-classification fields (`isBotMention`,
// `isDm`) that are turn-delivery concerns, not history concerns. History
// entries instead need `isBot` so the agent can tell its own past replies
// from user messages, and a sortable `ts` for chronological rendering.
export type ChannelHistoryMessage = {
  externalMessageId: string
  authorId: string
  authorName: string
  text: string
  ts: number
  isBot: boolean
  replyToBotMessageId: string | null
}

export type FetchHistoryArgs = {
  chat: string
  thread: string | null
  limit: number
  cursor?: string
}

export type FetchHistoryResult =
  | { ok: true; messages: ChannelHistoryMessage[]; nextCursor?: string }
  | { ok: false; error: string }

// Registered per-adapter on the ChannelRouter alongside outbound/typing
// callbacks. Adapters that cannot fetch history (e.g. webhook-only future
// adapters) simply do not register one; the router answers
// 'history-not-supported' for those.
export type HistoryCallback = (args: FetchHistoryArgs) => Promise<FetchHistoryResult>

export function channelKeyId(key: ChannelKey): string {
  return `${key.adapter}:${key.workspace}:${key.chat}:${key.thread ?? ''}`
}
