import type { LinePushMessageEvent } from 'agent-messenger/line'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

export type InboundDropReason = 'self_author' | 'empty_text' | 'unknown_chat' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type LineChatLookup = (chatId: string) => {
  workspace: '@line-dm' | '@line-group' | '@line-square'
  isDm: boolean
} | null

export type LineInboundContext = {
  selfUserId: string | null
  lookupChat: LineChatLookup
  selfAliases?: readonly string[]
  // LINE push events lack `author_name`, so the adapter resolves it (best
  // effort) and passes it here; falls back to the raw author id.
  authorName?: string
  // The adapter splits the raw event into prompt text + attachments (non-text
  // content types become a placeholder string and a ref-free attachment) and
  // passes the result here, so the classifier routes on the synthesized text
  // rather than the raw `event.text`. Omitted for plain text inbounds, where
  // `event.text` is authoritative.
  text?: string
  attachments?: readonly InboundAttachment[]
}

export function classifyInbound(
  event: LinePushMessageEvent,
  _config: ChannelAdapterConfig,
  context: LineInboundContext,
): InboundClassification {
  if (context.selfUserId === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }
  if (event.author_id === context.selfUserId) {
    return { kind: 'drop', reason: 'self_author' }
  }

  const text = context.text ?? event.text ?? ''
  const attachments = context.attachments ?? []
  if (text === '' && attachments.length === 0) {
    return { kind: 'drop', reason: 'empty_text' }
  }

  const chatInfo = context.lookupChat(event.chat_id)
  if (chatInfo === null) {
    return { kind: 'drop', reason: 'unknown_chat' }
  }

  // LINE has no native @-mention the push protocol surfaces. Like KakaoTalk,
  // mention-equivalent engagement comes solely from plain-text alias matching,
  // which the engagement layer ranks alongside an explicit mention.
  const aliasMatched = matchesAnyAlias(text, context.selfAliases ?? [])
  const authorName = context.authorName ?? event.author_id

  // LINE's `sent_at` is an ISO-ish string (vs KakaoTalk's Unix seconds). The
  // contract wants ms since epoch; a malformed timestamp degrades to 0
  // ("unknown") so the formatter omits the time prefix rather than stamping a
  // wrong clock.
  const parsed = Date.parse(event.sent_at)
  const ts = Number.isNaN(parsed) ? 0 : parsed

  return {
    kind: 'route',
    payload: {
      adapter: 'line',
      workspace: chatInfo.workspace,
      chat: event.chat_id,
      thread: null,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      externalMessageId: event.message_id,
      authorId: event.author_id,
      authorName,
      authorIsBot: false,
      isBotMention: aliasMatched,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: chatInfo.isDm,
      ts,
    },
  }
}
