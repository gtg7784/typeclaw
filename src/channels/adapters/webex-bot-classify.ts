import type { WebexBotListenerEventMap } from 'agent-messenger/webexbot'

import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

export type WebexInboundMessage = WebexBotListenerEventMap['message_created'][0]

export type InboundDropReason = 'self_author' | 'empty_content' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export function classifyInbound(
  event: WebexInboundMessage,
  _config: ChannelAdapterConfig,
  botPersonId: string | null,
): InboundClassification {
  if (botPersonId !== null && event.personId === botPersonId) {
    return { kind: 'drop', reason: 'self_author' }
  }

  const { text, attachments } = splitInbound(event)
  if (text === '') return { kind: 'drop', reason: 'empty_content' }

  if (botPersonId === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }

  const isDm = event.roomType === 'direct'
  const isBotMention = event.mentionedPeople.includes(botPersonId) || event.mentionedGroups.includes('all')
  const mentionsOthers = event.mentionedPeople.length > 0 && !event.mentionedPeople.includes(botPersonId)
  const ts = Date.parse(event.created)

  return {
    kind: 'route',
    payload: {
      adapter: 'webex-bot',
      // Webex message events do not include an org/team id; the room id is the
      // stable permission bucket for group spaces while DMs use the shared key.
      workspace: isDm ? '@dm' : event.roomId,
      chat: event.roomId,
      thread: null,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      externalMessageId: event.id,
      authorId: event.personId,
      authorName: event.personEmail,
      authorIsBot: false,
      isBotMention,
      // Webex Mercury only exposes parentId inline, not the parent author. When
      // the reply auto-mentions the bot we can identify it as bot-directed;
      // otherwise leave the parent unattributed instead of guessing.
      replyToBotMessageId: event.parentId !== undefined && isBotMention ? event.parentId : null,
      mentionsOthers,
      replyToOtherMessageId: null,
      isDm,
      ts: Number.isFinite(ts) ? ts : 0,
    },
  }
}

type SplitInbound = { text: string; attachments: InboundAttachment[] }

function splitInbound(event: WebexInboundMessage): SplitInbound {
  const attachments = event.files.map((ref, index) => ({
    id: index + 1,
    kind: 'file' as const,
    ref,
    filename: filenameFromUrl(ref) ?? `webex-file-${index + 1}`,
  }))
  if (attachments.length === 0) return { text: event.text, attachments: [] }
  const summary = attachments.map(renderPlaceholder).join('\n')
  const text = event.text === '' ? summary : `${event.text}\n${summary}`
  return { text, attachments }
}

function filenameFromUrl(ref: string): string | null {
  try {
    const url = new URL(ref)
    const name = url.pathname.split('/').filter(Boolean).pop()
    return name === undefined || name === '' ? null : name
  } catch {
    return null
  }
}

function renderPlaceholder(attachment: InboundAttachment): string {
  const parts: string[] = [`Webex attachment #${attachment.id}: ${attachment.kind}`]
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  return `[${parts.join(' ')}]`
}
