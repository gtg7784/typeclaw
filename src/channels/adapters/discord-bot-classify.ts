import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { DiscordGatewayMessageCreateEvent } from './agent-messenger-shim'

export type InboundDropReason =
  | 'bot_author' // event.author.bot === true; dropping prevents echo loops
  | 'empty_content' // SDK delivered content: '' — usually missing MessageContent intent
  | 'not_in_allow_list' // workspace/channel not admitted by typeclaw.json `channels.discord-bot.allow`

export type InboundClassification = { kind: 'drop'; reason: InboundDropReason } | { kind: 'route'; payload: InboundMessage }

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
  if (event.author.bot === true) return { kind: 'drop', reason: 'bot_author' }
  if (event.content === '') return { kind: 'drop', reason: 'empty_content' }

  const isDm = event.guild_id === undefined
  const workspace = isDm ? '@dm' : event.guild_id!
  if (!isAllowed(config.allow, workspace, event.channel_id)) {
    return { kind: 'drop', reason: 'not_in_allow_list' }
  }

  // botUserId is null until the listener has dispatched 'connected'. Treating
  // an event as a mention in that race window prevents the very first message
  // after start-up from being misclassified as ambient chatter.
  const isBotMention =
    botUserId !== null
      ? event.content.includes(`<@${botUserId}>`) || event.content.includes(`<@!${botUserId}>`)
      : true
  const replyToBotMessageId =
    event.message_reference?.message_id !== undefined && botUserId !== null
      ? event.message_reference.message_id
      : null

  return {
    kind: 'route',
    payload: {
      adapter: 'discord-bot',
      workspace,
      chat: event.channel_id,
      thread: null,
      text: event.content,
      externalMessageId: event.id,
      authorId: event.author.id,
      authorName: event.author.username,
      isBotMention,
      replyToBotMessageId,
      isDm,
    },
  }
}
