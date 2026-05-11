import type { KakaoTalkPushMessageEvent } from 'agent-messenger/kakaotalk'

import { matchesAnyAlias } from '@/channels/engagement'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

export type InboundDropReason = 'self_author' | 'empty_text' | 'unknown_chat' | 'not_in_allow_list' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type KakaoChatLookup = (chatId: string) => {
  workspace: '@kakao-dm' | '@kakao-group' | '@kakao-open'
  isDm: boolean
} | null

export type KakaoInboundContext = {
  selfUserId: string | null
  lookupChat: KakaoChatLookup
  selfAliases?: readonly string[]
}

export function classifyInbound(
  event: KakaoTalkPushMessageEvent,
  config: ChannelAdapterConfig,
  context: KakaoInboundContext,
): InboundClassification {
  if (context.selfUserId === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }
  if (String(event.author_id) === context.selfUserId) {
    return { kind: 'drop', reason: 'self_author' }
  }

  const text = event.message ?? ''
  if (text === '') return { kind: 'drop', reason: 'empty_text' }

  const chatInfo = context.lookupChat(event.chat_id)
  if (chatInfo === null) {
    return { kind: 'drop', reason: 'unknown_chat' }
  }

  if (!isAllowed(config.allow, chatInfo.workspace, event.chat_id)) {
    return { kind: 'drop', reason: 'not_in_allow_list' }
  }

  // KakaoTalk has no native @-mention syntax in the LOCO protocol that the
  // SDK exposes (mention rendering happens client-side via display_name
  // matching). Mention-equivalent engagement comes solely from alias
  // matching, which the engagement layer treats as equivalent to a direct
  // mention (see engagement.ts: alias is unconditional and ranks alongside
  // explicit triggers). Without aliases configured, only `reply` and `dm`
  // triggers can fire on KakaoTalk.
  const aliasMatched = matchesAnyAlias(text, context.selfAliases ?? [])

  return {
    kind: 'route',
    payload: {
      adapter: 'kakaotalk',
      workspace: chatInfo.workspace,
      chat: event.chat_id,
      thread: null,
      text,
      externalMessageId: event.log_id,
      authorId: String(event.author_id),
      authorName: event.author_name ?? String(event.author_id),
      authorIsBot: false,
      isBotMention: aliasMatched,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: chatInfo.isDm,
      ts: event.sent_at,
    },
  }
}
