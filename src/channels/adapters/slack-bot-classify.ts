import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { SlackSocketMessageEvent } from './agent-messenger-slack-shim'
import { slackTsToMillis } from './slack-bot-time'

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
  //
  // Group mentions (`<!here>`, `<!channel>`, `<!everyone>`) are coerced to
  // direct mentions: the user fired a broadcast that explicitly includes the
  // bot, and from the engagement layer's perspective there is no meaningful
  // difference between "@bot, look at this" and "@channel, look at this" —
  // both are an invitation to participate. Treating them identically also
  // means the existing 'mention' trigger in typeclaw.json catches both
  // without any new config surface.
  const hasGroupMention = GROUP_MENTION_PATTERN.test(text)
  const isBotMention = hasGroupMention || (context.botUserId !== null ? text.includes(`<@${context.botUserId}>`) : true)
  const thread = event.thread_ts ?? (!isDm && isBotMention ? event.ts : null)

  // thread_ts identifies the parent message of a thread. We can only know it
  // is a reply to the bot if we recognize the bot's own user id and have a
  // thread_ts that differs from the event ts (the parent message itself
  // shares its ts with thread_ts).
  const replyToBotMessageId =
    event.thread_ts !== undefined && event.thread_ts !== event.ts && context.botUserId !== null ? event.thread_ts : null

  // Defer the mentionsOthers signal until botUserId is known. During the
  // cold-start race window we cannot tell our own mention apart from a
  // foreign one, and a wrong `true` here would silently suppress the
  // very first inbound after start-up via the engagement layer.
  const mentionedUserIds = extractMentionedUserIds(text)
  const mentionsOthers =
    context.botUserId !== null && mentionedUserIds.length > 0 && !mentionedUserIds.includes(context.botUserId)

  // Slack does not surface the parent message's author on `event`, so we
  // cannot positively identify a reply-to-other from the inbound alone.
  // Leaving this null keeps the contract honest — the engagement layer's
  // mention-based suppressor still covers the common case of "@-someone
  // in a thread reply", and the solo-human fallback only matters in
  // 1-human channels where there is no "other" human to reply to anyway.
  const replyToOtherMessageId: string | null = null

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
      mentionsOthers,
      replyToOtherMessageId,
      isDm,
      ts: slackTsToMillis(event.ts),
    },
  }
}

// Slack encodes user mentions inline as `<@U…>` (or `<@W…>` for some org
// accounts, and `<@U…|fallback>` when the client supplied a label). Pull
// every distinct id out of the text — duplicates collapse so the caller
// can do a clean `includes()` check against the bot's own id.
const MENTION_PATTERN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

// Slack's group mention markup uses `!` (not `@`) and may carry an optional
// `|label` suffix, same as user mentions. We deliberately exclude the
// `<!subteam^ID>` form — engaging on every user-group ping would require
// knowing which subteams the bot is a member of, which is outside what
// Socket Mode events surface to us.
const GROUP_MENTION_PATTERN = /<!(?:here|channel|everyone)(?:\|[^>]*)?>/

function extractMentionedUserIds(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    seen.add(match[1]!)
  }
  return Array.from(seen)
}
