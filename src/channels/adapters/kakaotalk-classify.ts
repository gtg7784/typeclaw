import type { KakaoTalkPushMessageEvent } from 'agent-messenger/kakaotalk'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

export type InboundDropReason = 'self_author' | 'empty_text' | 'unknown_chat' | 'pre_connect' | 'bot_message'

// LOCO message_type 71 is KakaoTalk's notification/feed channel — official
// accounts like "카카오 고객센터" and "카카오계정" (login alerts, security
// notices, system messages). These arrive in @kakao-group buckets because
// they aren't normal user chats, but they are not human conversation and
// the agent should never reply to them. Not enumerated in
// agent-messenger's `KAKAO_MESSAGE_TYPE` because that const only covers
// user-composable types (TEXT/PHOTO/VIDEO/AUDIO/FILE/MULTIPHOTO).
const KAKAO_NOTIFICATION_MESSAGE_TYPE = 71

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
  // The adapter splits attachment refs out of prompt-visible text before
  // classification. Keeping them on context makes classifyInbound's payload
  // construction the single place that stamps InboundMessage fields.
  attachments?: readonly InboundAttachment[]
}

export function classifyInbound(
  event: KakaoTalkPushMessageEvent,
  _config: ChannelAdapterConfig,
  context: KakaoInboundContext,
): InboundClassification {
  if (context.selfUserId === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }
  if (String(event.author_id) === context.selfUserId) {
    return { kind: 'drop', reason: 'self_author' }
  }
  if (event.message_type === KAKAO_NOTIFICATION_MESSAGE_TYPE) {
    return { kind: 'drop', reason: 'bot_message' }
  }

  const text = event.message ?? ''
  if (text === '') return { kind: 'drop', reason: 'empty_text' }

  const chatInfo = context.lookupChat(event.chat_id)
  if (chatInfo === null) {
    return { kind: 'drop', reason: 'unknown_chat' }
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
      ...(context.attachments !== undefined && context.attachments.length > 0
        ? { attachments: context.attachments }
        : {}),
      externalMessageId: event.log_id,
      authorId: String(event.author_id),
      authorName: event.author_name ?? String(event.author_id),
      authorIsBot: false,
      isBotMention: aliasMatched,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: chatInfo.isDm,
      // SDK delivers `sent_at` in Unix seconds (LOCO `sendAt`); contract
      // wants ms (see `src/channels/types.ts`). Without `* 1000`, ms-based
      // renderers (inspect -f, etc.) produce 1970-01-21-shaped dates.
      ts: event.sent_at * 1000,
    },
  }
}
