import type { DiscordGatewayMessageCreateEvent } from 'agent-messenger/discord'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

import { encodeDiscordReactionRef } from './discord-reactions'

export type DiscordInboundMessageEvent = DiscordGatewayMessageCreateEvent

export type InboundDropReason = 'self_author' | 'no_user' | 'empty_content' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type DiscordInboundContext = {
  selfUserId: string | null
  selfAliases?: readonly string[]
}

export function classifyInbound(
  event: DiscordInboundMessageEvent,
  _config: ChannelAdapterConfig,
  context: DiscordInboundContext,
): InboundClassification {
  if (context.selfUserId !== null && event.author.id === context.selfUserId)
    return { kind: 'drop', reason: 'self_author' }
  if (event.author.id === '') return { kind: 'drop', reason: 'no_user' }
  const { text, attachments } = splitInbound(event)
  if (text === '') return { kind: 'drop', reason: 'empty_content' }
  if (context.selfUserId === null) return { kind: 'drop', reason: 'pre_connect' }

  const isDm = event.guild_id === undefined
  const workspace = isDm ? '@dm' : (event.guild_id ?? '')
  const hasGroupMention = GROUP_MENTION_PATTERN.test(event.content)
  const isBotMention =
    hasGroupMention ||
    event.content.includes(`<@${context.selfUserId}>`) ||
    event.content.includes(`<@!${context.selfUserId}>`)
  const aliasMatched = !isBotMention && matchesAnyAlias(event.content, context.selfAliases ?? [])
  const mentionedUsers = event.mentions ?? []
  const mentionsOthers = mentionedUsers.length > 0 && !mentionedUsers.some((user) => user.id === context.selfUserId)

  return {
    kind: 'route',
    payload: {
      adapter: 'discord',
      workspace,
      chat: event.channel_id,
      thread: null,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      externalMessageId: event.id,
      reactionRef: encodeDiscordReactionRef({ channel: event.channel_id, message: event.id }),
      authorId: event.author.id,
      authorName: event.author.username,
      authorIsBot: false,
      isBotMention: isBotMention || aliasMatched,
      replyToBotMessageId: null,
      mentionsOthers,
      replyToOtherMessageId: null,
      isDm,
      ts: parseDiscordTimestamp(event.timestamp),
    },
  }
}

const GROUP_MENTION_PATTERN = /@(?:everyone|here)/

type SplitInbound = { text: string; attachments: InboundAttachment[] }

function splitInbound(event: DiscordInboundMessageEvent): SplitInbound {
  const attachments = (event.attachments ?? []).map((attachment, index) => ({
    id: index + 1,
    kind: 'file' as const,
    ref: attachment.url,
    filename: attachment.filename,
    ...(attachment.content_type !== undefined ? { mimetype: attachment.content_type } : {}),
  }))
  if (attachments.length === 0) return { text: event.content, attachments: [] }
  const summary = attachments.map(renderPlaceholder).join('\n')
  const text = event.content === '' ? summary : `${event.content}\n${summary}`
  return { text, attachments }
}

function renderPlaceholder(attachment: InboundAttachment): string {
  const parts: string[] = [`Discord attachment #${attachment.id}: ${attachment.kind}`]
  if (attachment.mimetype !== undefined) parts.push(attachment.mimetype)
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  return `[${parts.join(' ')}]`
}

function parseDiscordTimestamp(timestamp: string): number {
  const millis = Date.parse(timestamp)
  return Number.isFinite(millis) ? millis : 0
}
