import type {
  DiscordFile,
  DiscordGatewayEmbed,
  DiscordGatewayMessageCreateEvent,
  DiscordGatewayStickerItem,
} from 'agent-messenger/discordbot'

import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

export type InboundDropReason =
  | 'self_author' // event.author.id === botUserId; we never route our own messages back to ourselves
  | 'empty_content' // SDK delivered content: '' — usually missing MessageContent intent
  | 'pre_connect' // bot identity is not known yet, so mention/self/reply classification cannot be trusted
  | 'thread_created_system' // Discord's THREAD_CREATED system notice posted to the PARENT channel when a public thread is created from a message

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
  _config: ChannelAdapterConfig,
  botUserId: string | null,
): InboundClassification {
  // Self-drop is the hard floor: we must never route our own messages back to
  // ourselves under any circumstance. We can only do this once botUserId is
  // known (post-connect); before that, fail closed below because mention,
  // reply, and self classification all depend on the bot identity.
  if (botUserId !== null && event.author.id === botUserId) {
    return { kind: 'drop', reason: 'self_author' }
  }
  const { text, attachments } = splitInbound(event)
  if (text === '') return { kind: 'drop', reason: 'empty_content' }

  if (isThreadCreatedSystemMessage(event)) {
    return { kind: 'drop', reason: 'thread_created_system' }
  }

  const isDm = event.guild_id === undefined
  const workspace = isDm ? '@dm' : event.guild_id!

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
      ...(attachments.length > 0 ? { attachments } : {}),
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

// Creating a public thread from a message fires TWO MESSAGE_CREATE events: a
// THREAD_CREATED notice in the parent channel (content = thread name) and a
// THREAD_STARTER_MESSAGE inside the thread. Each opens its own router session,
// so the agent replies twice. The numeric Discord message type (18) that would
// filter this cleanly is destroyed by the agent-messenger listener (it does
// `{ ...d, type: t }`, overwriting `d.type` with the dispatch name), so we
// fingerprint the notice by its reference instead: it points at a DIFFERENT
// channel (the new thread) with no source `message_id`. The message_id-absent
// check is load-bearing — it spares normal cross-channel replies and the
// in-thread starter, both of which DO carry a message_id.
function isThreadCreatedSystemMessage(event: DiscordGatewayMessageCreateEvent): boolean {
  const ref = event.message_reference
  if (ref?.channel_id === undefined) return false
  if (ref.channel_id === event.channel_id) return false
  if (ref.message_id !== undefined) return false
  return ref.guild_id === undefined || event.guild_id === undefined || ref.guild_id === event.guild_id
}

type SplitInbound = { text: string; attachments: InboundAttachment[] }

function splitInbound(event: DiscordGatewayMessageCreateEvent): SplitInbound {
  const attachments = describeDiscordMedia(event)
  if (attachments.length === 0) return { text: event.content, attachments: [] }
  const summary = attachments.map(renderPlaceholder).join('\n')
  const text = event.content === '' ? summary : `${event.content}\n${summary}`
  return { text, attachments }
}

export type DiscordMediaCarrier = {
  attachments?: DiscordFile[]
  embeds?: DiscordGatewayEmbed[]
  sticker_items?: DiscordGatewayStickerItem[]
}

export function describeDiscordMedia(event: DiscordMediaCarrier): InboundAttachment[] {
  return [
    ...(event.attachments ?? []).map(describeAttachment),
    ...(event.embeds ?? []).map(describeEmbed),
    ...(event.sticker_items ?? []).map(describeSticker),
  ].map((attachment, index) => ({ ...attachment, id: index + 1 }))
}

function describeAttachment(attachment: DiscordFile): Omit<InboundAttachment, 'id'> {
  return {
    kind: 'file',
    ref: attachment.url,
    filename: attachment.filename,
    ...(attachment.content_type !== undefined ? { mimetype: attachment.content_type } : {}),
  }
}

function describeEmbed(embed: DiscordGatewayEmbed): Omit<InboundAttachment, 'id'> {
  const label = embed.title ?? embed.description ?? embed.url ?? embed.type ?? 'embed'
  return { kind: 'embed', ref: embed.url ?? '', filename: label }
}

function describeSticker(sticker: DiscordGatewayStickerItem): Omit<InboundAttachment, 'id'> {
  return { kind: 'sticker', ref: '', filename: sticker.name }
}

export function renderPlaceholder(attachment: InboundAttachment): string {
  const parts: string[] = [`Discord attachment #${attachment.id}: ${attachment.kind}`]
  if (attachment.mimetype !== undefined) parts.push(attachment.mimetype)
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  return `[${parts.join(' ')}]`
}
