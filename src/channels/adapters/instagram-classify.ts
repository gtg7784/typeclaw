import type { InstagramMessageSummary } from 'agent-messenger/instagram'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { InstagramChatLookupValue } from './instagram-channel-resolver'

export type InboundDropReason = 'self_author' | 'empty_text' | 'unknown_chat' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type InstagramChatLookup = (chatId: string) => InstagramChatLookupValue | null

export type InstagramInboundContext = {
  selfUserId: string | null
  lookupChat: InstagramChatLookup
  selfAliases?: readonly string[]
}

export function classifyInbound(
  message: InstagramMessageSummary,
  _config: ChannelAdapterConfig,
  context: InstagramInboundContext,
): InboundClassification {
  if (context.selfUserId === null) return { kind: 'drop', reason: 'pre_connect' }
  if (message.is_outgoing || message.from === context.selfUserId) return { kind: 'drop', reason: 'self_author' }

  const rawText = message.text ?? ''
  if (rawText === '' && message.media_url === undefined) return { kind: 'drop', reason: 'empty_text' }
  const text = rawText === '' ? instagramMediaPlaceholder(message.type) : rawText

  const chatInfo = context.lookupChat(message.thread_id)
  if (chatInfo === null) return { kind: 'drop', reason: 'unknown_chat' }

  // Instagram summaries expose no native @-mention metadata. Group engagement
  // is therefore plain-text alias matching only; DMs engage every message.
  const aliasMatched = matchesAnyAlias(text, context.selfAliases ?? [])
  const parsed = Date.parse(message.timestamp)

  return {
    kind: 'route',
    payload: {
      adapter: 'instagram',
      workspace: chatInfo.workspace,
      chat: message.thread_id,
      thread: null,
      text,
      externalMessageId: message.id,
      authorId: message.from,
      authorName: message.from_name ?? message.from,
      authorIsBot: false,
      isBotMention: aliasMatched,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: chatInfo.isDm,
      ts: Number.isNaN(parsed) ? 0 : parsed,
    },
  }
}

function instagramMediaPlaceholder(type: string): string {
  const normalized = type.trim()
  if (normalized === '' || normalized === 'text') return '[Instagram media]'
  return `[Instagram ${normalized}]`
}
