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
  // known (post-connect); before that, fall through and let downstream layers
  // see the message — the cold-start race window is small and the alternative
  // (dropping every bot message including foreign ones) silently disables
  // peer-bot conversation.
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

  // botUserId is null until the listener has dispatched 'connected'. Treating
  // an event as a mention in that race window prevents the very first message
  // after start-up from being misclassified as ambient chatter.
  const isBotMention =
    botUserId !== null ? event.content.includes(`<@${botUserId}>`) || event.content.includes(`<@!${botUserId}>`) : true
  const replyToBotMessageId =
    event.message_reference?.message_id !== undefined && botUserId !== null ? event.message_reference.message_id : null

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
      authorName: event.author.username,
      authorIsBot: event.author.bot === true,
      isBotMention,
      replyToBotMessageId,
      isDm,
    },
  }
}

function inboundText(event: DiscordGatewayMessageCreateEvent): string {
  if (event.content !== '') return event.content
  const mediaSummary = summarizeDiscordMedia(event)
  return mediaSummary.length > 0 ? `[Discord message with ${mediaSummary.join('; ')}]` : ''
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
