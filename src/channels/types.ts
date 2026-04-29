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

export function channelKeyId(key: ChannelKey): string {
  return `${key.adapter}:${key.workspace}:${key.chat}:${key.thread ?? ''}`
}
