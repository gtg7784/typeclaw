import { matchesAnyAlias } from '@/channels/engagement'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { SlackFile, SlackSocketMessageEvent } from './agent-messenger-slack-shim'
import { slackTsToMillis } from './slack-bot-time'

export type InboundDropReason =
  | 'self_author' // event.user === botUserId; we never route our own messages back to ourselves
  | 'no_user' // event has no `user` field (e.g. system messages: channel_join, message_changed)
  | 'empty_text' // event has neither text nor files — nothing for the agent to act on
  | 'not_in_allow_list' // workspace/channel not admitted by typeclaw.json `channels.slack-bot.allow`
  | 'pre_connect' // bot identity is not known yet, so mention/self/reply classification cannot be trusted

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type SlackInboundContext = {
  teamId: string
  botUserId: string | null
  // Lowered self-aliases (`alias` from typeclaw.json plus the implicit
  // basename(agentDir)). When a top-level message contains one of these
  // but no `<@bot>` mention, the classifier still anchors `thread` on
  // `event.ts` so the bot's reply lands in a thread under the user's
  // message instead of as a fragmented top-level post. Optional for
  // backward compatibility — omitted means "behave like before, no
  // alias-driven thread anchoring". The router's `computeSelfAliases`
  // is the source of truth; the adapter just forwards it.
  selfAliases?: readonly string[]
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
  // ourselves. The check requires `botUserId` (post-auth.test); before that,
  // fail closed below because mention, reply, and self classification all
  // depend on the bot identity.
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

  const rawText = event.text ?? ''
  const text = inboundText(event)
  if (text === '') return { kind: 'drop', reason: 'empty_text' }

  const isDm = event.channel_type === 'im'
  const workspace = isDm ? '@dm' : context.teamId
  if (!isAllowed(config.allow, workspace, event.channel)) {
    return { kind: 'drop', reason: 'not_in_allow_list' }
  }

  if (context.botUserId === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }

  // Mention parsing runs against the raw user-typed text only — the
  // appended `[Slack message with attachment: ...]` summary contains URLs
  // and ids that must not be misread as mentions or group broadcasts.
  // Group mentions (`<!here>`, `<!channel>`, `<!everyone>`) are coerced to
  // direct mentions: the user fired a broadcast that explicitly includes the
  // bot, and from the engagement layer's perspective there is no meaningful
  // difference between "@bot, look at this" and "@channel, look at this" —
  // both are an invitation to participate. Treating them identically also
  // means the existing 'mention' trigger in typeclaw.json catches both
  // without any new config surface.
  const hasGroupMention = GROUP_MENTION_PATTERN.test(rawText)
  const isBotMention = hasGroupMention || rawText.includes(`<@${context.botUserId}>`)
  // Top-level alias addressing (e.g. "윙키야") is engagement-equivalent
  // to a `<@bot>` mention (see engagement.ts: alias is unconditional and
  // ranks alongside explicit triggers). Anchor `thread` on the inbound
  // ts in that case too, so the bot's reply threads under the user's
  // message rather than landing as a sibling top-level post. Mention
  // wins the OR short-circuit; alias matching only runs when no @ was
  // found, keeping the cost negligible in mention-heavy channels.
  const aliasMatched = !isBotMention && matchesAnyAlias(rawText, context.selfAliases ?? [])
  const thread = event.thread_ts ?? (!isDm && (isBotMention || aliasMatched) ? event.ts : null)

  // A reply is "to the bot" only when the thread parent was authored by the
  // bot. Slack surfaces the parent author via `parent_user_id` on every
  // reply event; without that match we don't know who authored the parent
  // and MUST NOT engage on the `reply` trigger — otherwise every threaded
  // reply between two humans (or two peer bots) wakes us up. The thread
  // root itself shares its ts with thread_ts and carries no parent_user_id.
  const isReply = event.thread_ts !== undefined && event.thread_ts !== event.ts
  const replyToBotMessageId =
    isReply && context.botUserId !== null && event.parent_user_id === context.botUserId ? event.thread_ts! : null

  const mentionedUserIds = extractMentionedUserIds(rawText)
  const mentionsOthers = mentionedUserIds.length > 0 && !mentionedUserIds.includes(context.botUserId)

  // Symmetric to `replyToBotMessageId` above: a reply whose parent author
  // is identifiable AND is not the bot is a reply-to-other. The engagement
  // layer uses this to suppress the solo-human fallback so the bot stays
  // quiet when two humans (or a peer bot and a human) hold a thread side-
  // conversation in a busy channel — the exact incident this fix addresses.
  const replyToOtherMessageId =
    isReply &&
    event.parent_user_id !== undefined &&
    event.parent_user_id !== '' &&
    event.parent_user_id !== context.botUserId
      ? event.thread_ts!
      : null

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

function inboundText(event: SlackSocketMessageEvent): string {
  const rawText = event.text ?? ''
  const mediaSummary = summarizeSlackMedia(event)
  if (mediaSummary.length === 0) return rawText
  const summary = `[Slack message with ${mediaSummary.join('; ')}]`
  return rawText === '' ? summary : `${rawText}\n${summary}`
}

function summarizeSlackMedia(event: SlackSocketMessageEvent): string[] {
  return (event.files ?? []).map(summarizeSlackFile)
}

function summarizeSlackFile(file: SlackFile): string {
  const parts: string[] = [`attachment: ${file.name}`, `(${file.mimetype})`, `id=${file.id}`]
  return parts.join(' ')
}
