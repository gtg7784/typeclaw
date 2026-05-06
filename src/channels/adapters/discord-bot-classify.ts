import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type {
  DiscordGatewayAttachment,
  DiscordGatewayEmbed,
  DiscordGatewayMessageCreateEvent,
  DiscordGatewayStickerItem,
} from './agent-messenger-shim'

export type InboundDropReason =
  | 'self_author' // event.author.id === botUserId; we never route our own messages back to ourselves
  | 'empty_content' // SDK delivered content: '' — usually missing MessageContent intent
  | 'not_in_allow_list' // workspace/channel not admitted by typeclaw.json `channels.discord-bot.allow`
  | 'pre_connect' // bot identity is not known yet, so mention/self/reply classification cannot be trusted

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

// All decision logic for "should this gateway event be routed to the agent?"
// lives here so it can be unit-tested in isolation. The adapter is left as a
// thin shell that handles SDK lifecycle and translates this verdict into
// log lines + router calls. Adding a new drop reason MUST extend
// InboundDropReason — there is no `default` log path, so the type system
// forces logging to stay exhaustive.
export function classifyInbound(
  event: DiscordGatewayMessageCreateEvent,
  config: ChannelAdapterConfig,
  botUserId: string | null,
): InboundClassification {
  // Self-drop is the hard floor: we must never route our own messages back to
  // ourselves under any circumstance. We can only do this once botUserId is
  // known (post-connect); before that, fail closed below because mention,
  // reply, and self classification all depend on the bot identity.
  if (botUserId !== null && event.author.id === botUserId) {
    return { kind: 'drop', reason: 'self_author' }
  }
  const text = inboundText(event)
  if (text === '') return { kind: 'drop', reason: 'empty_content' }

  const isDm = event.guild_id === undefined
  const workspace = isDm ? '@dm' : event.guild_id!
  if (!isAllowed(config.allow, workspace, event.channel_id)) {
    return { kind: 'drop', reason: 'not_in_allow_list' }
  }

  if (botUserId === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }

  // Group mentions (`@everyone`, `@here`, role mentions) are coerced to
  // direct mentions: the broadcast explicitly includes the bot, and the
  // engagement layer doesn't meaningfully distinguish "@bot" from "@channel"
  // — both invite participation. Reusing isBotMention also means the
  // existing 'mention' trigger in typeclaw.json catches both with no new
  // config surface. Discord's gateway already provides structured fields
  // for these, so we don't need to parse content.
  const hasGroupMention = event.mention_everyone === true || (event.mention_roles ?? []).length > 0
  const isBotMention =
    hasGroupMention || event.content.includes(`<@${botUserId}>`) || event.content.includes(`<@!${botUserId}>`)

  // Discord sends a structured `mentions` array on every message, so we can
  // tell "tagged someone other than us" apart from "no mentions at all"
  // without parsing the content.
  const mentionsOthers = (event.mentions ?? []).length > 0 && !(event.mentions ?? []).some((m) => m.id === botUserId)

  const replyToParentId = event.message_reference?.message_id
  const replyToBotMessageId = replyToParentId !== undefined && isReplyToBot(event, botUserId) ? replyToParentId : null
  // Discord does not echo the parent message's author on `message_reference`,
  // but in practice the replied-to user is auto-mentioned in the reply's
  // `mentions` array (this is how the Discord client renders the "Replying
  // to @user" header). So when the parent reference exists and our id is NOT
  // among the mentions, the reply is targeted at someone else.
  const replyToOtherMessageId = replyToParentId !== undefined && replyToBotMessageId === null ? replyToParentId : null

  const ts = Date.parse(event.timestamp)

  return {
    kind: 'route',
    payload: {
      adapter: 'discord-bot',
      workspace,
      chat: event.channel_id,
      thread: null,
      text,
      externalMessageId: event.id,
      authorId: event.author.id,
      // Discord's post-2023 username system allows pure-numeric handles (e.g.
      // "1411531"); the human-facing display name lives on `global_name`. The
      // history mapper in discord-bot.ts uses the same fallback chain — keep
      // them aligned so the agent sees a stable identity for a given user
      // regardless of whether the message arrived live or via history.
      authorName: event.author.global_name ?? event.author.username,
      authorIsBot: event.author.bot === true,
      isBotMention,
      replyToBotMessageId,
      mentionsOthers,
      replyToOtherMessageId,
      isDm,
      ts: Number.isFinite(ts) ? ts : 0,
    },
  }
}

// Discord's `message_reference.message_id` only carries the parent id, not
// the parent author. We infer "this reply targets the bot" from the auto-
// mention Discord injects into the reply's `mentions` array (the same
// mechanism that drives the "Replying to @user" header in the client).
function isReplyToBot(event: DiscordGatewayMessageCreateEvent, botUserId: string): boolean {
  return (event.mentions ?? []).some((m) => m.id === botUserId)
}

function inboundText(event: DiscordGatewayMessageCreateEvent): string {
  const mediaSummary = summarizeDiscordMedia(event)
  if (mediaSummary.length === 0) return event.content
  const summary = `[Discord message with ${mediaSummary.join('; ')}]`
  return event.content === '' ? summary : `${event.content}\n${summary}`
}

function summarizeDiscordMedia(event: DiscordGatewayMessageCreateEvent): string[] {
  return [
    ...(event.attachments ?? []).map(summarizeAttachment),
    ...(event.embeds ?? []).map(summarizeEmbed),
    ...(event.sticker_items ?? []).map(summarizeSticker),
  ]
}

function summarizeAttachment(attachment: DiscordGatewayAttachment): string {
  return compactJoin(' ', [
    `attachment: ${attachment.filename}`,
    attachment.content_type === undefined ? undefined : `(${attachment.content_type})`,
    attachment.url,
  ])
}

function summarizeEmbed(embed: DiscordGatewayEmbed): string {
  const label = embed.title ?? embed.description ?? embed.url ?? embed.type ?? 'embed'
  return compactJoin(' ', ['embed:', label, embed.url !== undefined && embed.url !== label ? embed.url : undefined])
}

function summarizeSticker(sticker: DiscordGatewayStickerItem): string {
  return `sticker: ${sticker.name}`
}

function compactJoin(separator: string, parts: Array<string | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== '').join(separator)
}
