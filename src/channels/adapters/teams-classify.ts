import type { TeamsRealtimeMessage, TeamsUser } from 'agent-messenger/teams'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { TeamsChatInfo } from './teams'

export type TeamsInboundEvent = TeamsRealtimeMessage

export type InboundDropReason = 'self_author' | 'empty_content' | 'pre_connect' | 'unknown_chat'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

// The realtime event only carries a chatId, so channel-message routing (which
// needs a teamId + channelId) is out of scope; every routed inbound is a chat
// message keyed as `chat:<chatId>`. `chat` is the caller's already-validated
// TeamsChatInfo for that id (undefined ⇒ the adapter could not resolve it even
// after a refresh, so drop as unknown_chat rather than guess isDm).
//
// The agent-messenger listener strips all HTML (including `<at id>` mention
// tags) before emitting, so structured mention detection is impossible from a
// realtime event. Engagement is therefore intentionally conservative: DMs
// engage via the `dm` trigger; group chats engage ONLY when a configured alias
// appears in the plain text. A group message with no alias hit is marked
// `mentionsOthers` so the router's solo-human fallback does not make the agent
// answer chatter it was never addressed in.
export function classifyInbound(
  event: TeamsInboundEvent,
  _config: ChannelAdapterConfig,
  self: TeamsUser | null,
  chat: TeamsChatInfo | undefined,
  selfAliases: readonly string[] = [],
): InboundClassification {
  if (self === null) return { kind: 'drop', reason: 'pre_connect' }
  if (chat === undefined) return { kind: 'drop', reason: 'unknown_chat' }

  const text = event.content.trim()
  if (text === '') return { kind: 'drop', reason: 'empty_content' }

  const isDm = chat.type === 'oneOnOne' || chat.type === 'self'
  const isBotMention = matchesAnyAlias(text, selfAliases)
  const ts = Date.parse(event.timestamp)

  return {
    kind: 'route',
    payload: {
      adapter: 'teams',
      workspace: 'teams',
      chat: `chat:${event.chatId}`,
      thread: null,
      text,
      externalMessageId: event.id,
      authorId: event.author.id,
      authorName: event.author.displayName,
      authorIsBot: false,
      isBotMention,
      // `sendChatMessage` has no reply/thread anchor and the realtime event
      // exposes no parent id, so a reply can never be attributed.
      replyToBotMessageId: null,
      // Group messages carry no recoverable mention metadata. `mentionsOthers`
      // suppresses the solo-human fallback, and `suppressSticky` stops a prior
      // alias-triggered turn from keeping the agent engaged on later unaddressed
      // messages — together they make an un-aliased group message fail closed.
      // Neither fires in a DM, where the `dm` trigger always engages.
      suppressSticky: !isDm && !isBotMention,
      mentionsOthers: !isDm && !isBotMention,
      replyToOtherMessageId: null,
      isDm,
      ts: Number.isFinite(ts) ? ts : 0,
    },
  }
}

export function normalizeTeamsText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
