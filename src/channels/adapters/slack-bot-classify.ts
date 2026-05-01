import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { SlackSocketMessageEvent } from './agent-messenger-slack-shim'

export type InboundDropReason =
  | 'bot_author' // event.bot_id set or subtype === 'bot_message'; dropping prevents echo loops
  | 'no_user' // event has no `user` field (e.g. system messages: channel_join, message_changed)
  | 'empty_text' // event.text is empty or missing — nothing for the agent to act on
  | 'not_in_allow_list' // workspace/channel not admitted by typeclaw.json `channels.slack-bot.allow`

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type SlackInboundContext = {
  teamId: string
  botUserId: string | null
}

// All decision logic for "should this Socket Mode message event be routed to
// the agent?" lives here so it can be unit-tested in isolation. The adapter
// is left as a thin shell that handles SDK lifecycle and translates this
// verdict into log lines + router calls. Adding a new drop reason MUST extend
// InboundDropReason — there is no `default` log path, so the type system
// forces logging to stay exhaustive.
export function classifyInbound(
  event: SlackSocketMessageEvent,
  config: ChannelAdapterConfig,
  context: SlackInboundContext,
): InboundClassification {
  if (event.bot_id !== undefined && event.bot_id !== '') return { kind: 'drop', reason: 'bot_author' }
  if (event.subtype === 'bot_message') return { kind: 'drop', reason: 'bot_author' }
  if (event.user === undefined || event.user === '') return { kind: 'drop', reason: 'no_user' }
  if (context.botUserId !== null && event.user === context.botUserId) return { kind: 'drop', reason: 'bot_author' }

  const text = event.text ?? ''
  if (text === '') return { kind: 'drop', reason: 'empty_text' }

  const isDm = event.channel_type === 'im'
  const workspace = isDm ? '@dm' : context.teamId
  if (!isAllowed(config.allow, workspace, event.channel)) {
    return { kind: 'drop', reason: 'not_in_allow_list' }
  }

  // botUserId is null until app.connections.open returns auth metadata. In
  // that race window, treat any inbound as a mention so the very first
  // message after start-up isn't misclassified as ambient chatter.
  const isBotMention = context.botUserId !== null ? text.includes(`<@${context.botUserId}>`) : true
  const thread = event.thread_ts ?? (!isDm && isBotMention ? event.ts : null)

  // thread_ts identifies the parent message of a thread. We can only know it
  // is a reply to the bot if we recognize the bot's own user id and have a
  // thread_ts that differs from the event ts (the parent message itself
  // shares its ts with thread_ts).
  const replyToBotMessageId =
    event.thread_ts !== undefined && event.thread_ts !== event.ts && context.botUserId !== null ? event.thread_ts : null

  return {
    kind: 'route',
    payload: {
      adapter: 'slack-bot',
      workspace,
      chat: event.channel,
      thread,
      text,
      externalMessageId: event.ts,
      authorId: event.user,
      authorName: event.user,
      isBotMention,
      replyToBotMessageId,
      isDm,
    },
  }
}
