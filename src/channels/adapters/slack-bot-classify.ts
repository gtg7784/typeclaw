import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { SlackSocketMessageEvent } from './agent-messenger-slack-shim'

export type InboundDropReason =
  | 'self_author' // event.user === botUserId; we never route our own messages back to ourselves
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
  // Self-drop is the hard floor: never route our own messages back to
  // ourselves. The check requires `botUserId` (post-auth.test) — before
  // that, slack-bot.ts already rejects with `pre_connected`, so reaching
  // here without botUserId means a bot peer's message in the cold-start
  // window. Let it through (loop guard in the router covers the worst case).
  if (context.botUserId !== null && event.user === context.botUserId) {
    return { kind: 'drop', reason: 'self_author' }
  }
  if (event.user === undefined || event.user === '') {
    // System events (channel_join, message_changed, …) have no `user`;
    // they were also the ONLY way previously to flag bot_message subtype
    // events with no user. Now that we accept peer bots, a `bot_message`
    // subtype WITH a user (rare, but happens for legacy integrations) is
    // routed; subtype + no user still drops as `no_user`.
    return { kind: 'drop', reason: 'no_user' }
  }

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

  // Slack signals "this message was authored by a bot" via either a non-empty
  // bot_id or subtype === 'bot_message'. Either is sufficient.
  const authorIsBot = (event.bot_id !== undefined && event.bot_id !== '') || event.subtype === 'bot_message'

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
      authorIsBot,
      isBotMention,
      replyToBotMessageId,
      isDm,
    },
  }
}
