import type { TelegramBotUser, TelegramMessage, TelegramMessageEntity } from 'agent-messenger/telegrambot'

import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

export type InboundDropReason = 'self_author' | 'no_user' | 'empty_text' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export const TELEGRAM_WORKSPACE = 'telegram'

// Telegram has no team/guild concept — every chat is identified by an
// absolute (signed) numeric id. We pin `workspace` to a single bucket so
// match rules like `telegram:*` and `telegram:<chat_id>` resolve against
// a stable key downstream in the permissions service. DMs use `private`
// chats and route the same way as group chats from the router's
// perspective; `isDm` is set from `chat.type` so the engagement layer
// can apply the DM-specific trigger.
export function classifyInbound(
  event: TelegramMessage,
  _config: ChannelAdapterConfig,
  bot: TelegramBotUser | null,
): InboundClassification {
  const author = event.from
  if (author === undefined) {
    return { kind: 'drop', reason: 'no_user' }
  }
  if (bot !== null && author.id === bot.id) {
    return { kind: 'drop', reason: 'self_author' }
  }

  const { text, attachments } = splitInbound(event)
  if (text === '') return { kind: 'drop', reason: 'empty_text' }

  const chat = String(event.chat.id)

  if (bot === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }

  const isDm = event.chat.type === 'private'
  const entities = event.entities ?? event.caption_entities ?? []
  const fullText = event.text ?? event.caption ?? ''
  const botUsername = bot.username
  const userEntities = entities.filter(isUserMentionEntity)
  const isBotMention = isDm || mentionsBot(entities, fullText, bot.id, botUsername)
  // Mirror the Discord/Slack semantics: `mentionsOthers` is true only when
  // the message contains user-mention entities AND none of them resolve to
  // the bot. If the bot is in the mention list, the message is at least
  // partially addressed to us, so the engagement layer should not suppress
  // the solo-human fallback on the basis of a "tagged someone else" signal.
  const mentionsOthers =
    userEntities.length > 0 && !userEntities.some((e) => isUserMentionForBot(e, fullText, bot.id, botUsername))

  const replyParent = event.reply_to_message
  const replyToBotMessageId =
    replyParent !== undefined && replyParent.from?.id === bot.id ? String(replyParent.message_id) : null
  const replyToOtherMessageId =
    replyParent !== undefined && replyToBotMessageId === null ? String(replyParent.message_id) : null

  const thread = event.message_thread_id !== undefined ? String(event.message_thread_id) : null

  return {
    kind: 'route',
    payload: {
      adapter: 'telegram-bot',
      workspace: TELEGRAM_WORKSPACE,
      chat,
      thread,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      externalMessageId: String(event.message_id),
      authorId: String(author.id),
      authorName: formatAuthorName(author),
      authorIsBot: author.is_bot === true,
      isBotMention,
      replyToBotMessageId,
      mentionsOthers,
      replyToOtherMessageId,
      isDm,
      ts: event.date * 1000,
    },
  }
}

function formatAuthorName(user: TelegramBotUser): string {
  if (user.username !== undefined && user.username !== '') return user.username
  const last = user.last_name ?? ''
  return last === '' ? user.first_name : `${user.first_name} ${last}`
}

// Telegram's privacy mode only delivers messages that mention the bot
// (`@<botname>` or `text_mention` entity targeting the bot's id), are
// replies to bot messages, or are slash commands. We mirror that by treating
// any of those signals as a bot mention from the engagement layer's view.
function mentionsBot(
  entities: readonly TelegramMessageEntity[],
  fullText: string,
  botId: number,
  botUsername: string | undefined,
): boolean {
  for (const entity of entities) {
    if (entity.type === 'text_mention' && entity.user?.id === botId) return true
    if (entity.type === 'mention' && botUsername !== undefined) {
      const slice = fullText.slice(entity.offset, entity.offset + entity.length)
      if (slice.toLowerCase() === `@${botUsername.toLowerCase()}`) return true
    }
  }
  return false
}

function isUserMentionEntity(entity: TelegramMessageEntity): boolean {
  return entity.type === 'mention' || entity.type === 'text_mention'
}

function isUserMentionForBot(
  entity: TelegramMessageEntity,
  fullText: string,
  botId: number,
  botUsername: string | undefined,
): boolean {
  if (entity.type === 'text_mention') {
    return entity.user?.id === botId
  }
  if (entity.type === 'mention' && botUsername !== undefined) {
    const slice = fullText.slice(entity.offset, entity.offset + entity.length)
    return slice.toLowerCase() === `@${botUsername.toLowerCase()}`
  }
  return false
}

type SplitInbound = { text: string; attachments: InboundAttachment[] }

function splitInbound(event: TelegramMessage): SplitInbound {
  const body = event.text ?? event.caption ?? ''
  const attachments = describeMedia(event)
  if (attachments.length === 0) return { text: body, attachments: [] }
  const summary = attachments.map(renderPlaceholder).join('\n')
  const text = body === '' ? summary : `${body}\n${summary}`
  return { text, attachments }
}

function describeMedia(event: TelegramMessage): InboundAttachment[] {
  const parts: InboundAttachment[] = []
  if (event.document !== undefined) {
    parts.push({
      id: parts.length + 1,
      kind: 'file',
      ref: event.document.file_id,
      ...(event.document.file_name !== undefined ? { filename: event.document.file_name } : {}),
      ...(event.document.mime_type !== undefined ? { mimetype: event.document.mime_type } : {}),
    })
  }
  if (event.photo !== undefined && event.photo.length > 0) {
    const largest = event.photo[event.photo.length - 1]!
    parts.push({
      id: parts.length + 1,
      kind: 'photo',
      ref: largest.file_id,
      width: largest.width,
      height: largest.height,
    })
  }
  return parts
}

function renderPlaceholder(attachment: InboundAttachment): string {
  const parts: string[] = [`Telegram attachment #${attachment.id}: ${attachment.kind}`]
  if (attachment.width !== undefined && attachment.height !== undefined)
    parts.push(`${attachment.width}x${attachment.height}`)
  if (attachment.mimetype !== undefined) parts.push(attachment.mimetype)
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  return `[${parts.join(' ')}]`
}
