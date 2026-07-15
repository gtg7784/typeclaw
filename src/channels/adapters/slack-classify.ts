import type { SlackRTMMessageEvent } from 'agent-messenger/slack'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import { slackTsToMillis } from './slack-bot-time'
import { encodeSlackReactionRef } from './slack-reactions'

export type SlackInboundMessageEvent = SlackRTMMessageEvent & {
  channel_type?: string
  is_mpim?: boolean
}

export type SlackConversationType = 'im' | 'mpim' | 'channel'

export type InboundDropReason = 'self_author' | 'no_user' | 'slack_system_message' | 'empty_text' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type SlackInboundContext = {
  teamId: string
  selfUserId: string | null
  selfAliases?: readonly string[]
  conversationType?: SlackConversationType
}

export function classifyInbound(
  event: SlackInboundMessageEvent,
  _config: ChannelAdapterConfig,
  context: SlackInboundContext,
): InboundClassification {
  if (context.selfUserId !== null && event.user === context.selfUserId) return { kind: 'drop', reason: 'self_author' }
  if (event.user === undefined || event.user === '') return { kind: 'drop', reason: 'no_user' }
  if (!isRouteableSlackMessageSubtype(event.subtype)) return { kind: 'drop', reason: 'slack_system_message' }
  if ((event.text ?? '') === '') return { kind: 'drop', reason: 'empty_text' }
  if (context.selfUserId === null) return { kind: 'drop', reason: 'pre_connect' }

  const rawText = event.text ?? ''
  const conversationType = classifyConversation(event, context.conversationType)
  const isDm = conversationType === 'im'
  const workspace = isDm ? '@dm' : context.teamId
  const hasGroupMention = GROUP_MENTION_PATTERN.test(rawText)
  const isBotMention = hasGroupMention || rawText.includes(`<@${context.selfUserId}>`)
  const aliasMatched = !isBotMention && matchesAnyAlias(rawText, context.selfAliases ?? [])
  const thread = event.thread_ts ?? (!isDm && (isBotMention || aliasMatched) ? event.ts : null)
  const mentionedUserIds = extractMentionedUserIds(rawText)
  const mentionsOthers = mentionedUserIds.length > 0 && !mentionedUserIds.includes(context.selfUserId)

  return {
    kind: 'route',
    payload: {
      adapter: 'slack',
      workspace,
      chat: event.channel,
      thread,
      ...(thread !== null ? { room: { kind: 'thread' as const } } : {}),
      text: rawText,
      externalMessageId: event.ts,
      reactionRef: encodeSlackReactionRef({ channel: event.channel, ts: event.ts }),
      authorId: event.user,
      authorName: event.user,
      authorIsBot: false,
      isBotMention,
      // RTM user-session replies do not include parent_user_id; a pure classifier
      // cannot prove parent authorship without an async Slack lookup.
      replyToBotMessageId: null,
      mentionsOthers,
      replyToOtherMessageId: null,
      isDm,
      ts: slackTsToMillis(event.ts),
    },
  }
}

function classifyConversation(
  event: SlackInboundMessageEvent,
  resolvedType: SlackConversationType | undefined,
): SlackConversationType {
  if (event.channel_type === 'im' || event.channel_type === 'mpim' || event.channel_type === 'channel') {
    return event.channel_type
  }
  if (event.is_mpim === true) return 'mpim'
  if (resolvedType !== undefined) return resolvedType
  return event.channel.startsWith('D') ? 'im' : 'channel'
}

export function isRouteableSlackMessageSubtype(subtype: string | undefined): boolean {
  return subtype === undefined || subtype === 'me_message'
}

const MENTION_PATTERN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g
const GROUP_MENTION_PATTERN = /<!(?:here|channel|everyone)(?:\|[^>]*)?>/

function extractMentionedUserIds(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    seen.add(match[1]!)
  }
  return Array.from(seen)
}
