import { describe, expect, test } from 'bun:test'

import type { TelegramBotUser, TelegramMessage } from 'agent-messenger/telegrambot'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound, TELEGRAM_WORKSPACE } from './telegram-bot-classify'

const BOT: TelegramBotUser = { id: 999, is_bot: true, first_name: 'TypeClaw', username: 'typeclaw_bot' }

const baseConfig: ChannelAdapterConfig = {
  allow: ['*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
}

function buildMessage(over: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: -100123, type: 'supergroup', title: 'Eng' },
    from: { id: 1, is_bot: false, first_name: 'Alice', username: 'alice' },
    text: 'hello',
    ...over,
  }
}

describe('telegram-bot classifyInbound — drops', () => {
  test('drops messages whose author is the bot itself', () => {
    const event = buildMessage({ from: { id: BOT.id, is_bot: true, first_name: 'TypeClaw' } })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops anonymous channel posts (no `from` field) with reason=no_user', () => {
    const event = buildMessage({ from: undefined, chat: { id: -1001, type: 'channel', title: 'Announcements' } })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict).toEqual({ kind: 'drop', reason: 'no_user' })
  })

  test('drops messages with empty text and no recognized media (privacy mode footgun)', () => {
    const event = buildMessage({ text: undefined })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_text' })
  })

  test('drops chats not admitted by the allow list', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: ['tg:-100999'] }
    const event = buildMessage()

    const verdict = classifyInbound(event, config, BOT)

    expect(verdict).toEqual({ kind: 'drop', reason: 'not_in_allow_list' })
  })

  test('drops messages received before the bot identity is known', () => {
    const event = buildMessage()

    const verdict = classifyInbound(event, baseConfig, null)

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('self-author drop wins over allow-list filtering (precedence)', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: [] }
    const event = buildMessage({ from: { id: BOT.id, is_bot: true, first_name: 'TypeClaw' } })

    const verdict = classifyInbound(event, config, BOT)

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })
})

describe('telegram-bot classifyInbound — routing', () => {
  test('routes a group message with workspace=telegram and chat=<chat_id>', () => {
    const event = buildMessage()

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toEqual({
      adapter: 'telegram-bot',
      workspace: TELEGRAM_WORKSPACE,
      chat: '-100123',
      thread: null,
      text: 'hello',
      externalMessageId: '1',
      authorId: '1',
      authorName: 'alice',
      authorIsBot: false,
      isBotMention: false,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: 1_700_000_000_000,
    })
  })

  test('private chats route with isDm=true and isBotMention=true (DMs are always mentions)', () => {
    const event = buildMessage({
      chat: { id: 42, type: 'private', first_name: 'Alice' },
      from: { id: 1, is_bot: false, first_name: 'Alice' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.chat).toBe('42')
  })

  test('detects @-username mentions as bot mentions', () => {
    const event = buildMessage({
      text: 'hey @typeclaw_bot can you check?',
      entities: [{ type: 'mention', offset: 4, length: 13 }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('@-mention matching is case-insensitive (Telegram usernames are case-insensitive)', () => {
    const event = buildMessage({
      text: 'hey @TypeClaw_Bot',
      entities: [{ type: 'mention', offset: 4, length: 13 }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('detects text_mention entities targeting the bot id (botless usernames)', () => {
    const botNoUsername: TelegramBotUser = { id: 999, is_bot: true, first_name: 'TypeClaw' }
    const event = buildMessage({
      text: 'hey there',
      entities: [{ type: 'text_mention', offset: 0, length: 9, user: botNoUsername }],
    })

    const verdict = classifyInbound(event, baseConfig, botNoUsername)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('non-mention messages route with isBotMention=false', () => {
    const event = buildMessage({ text: 'good morning team' })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('reply to bot message surfaces replyToBotMessageId, not replyToOtherMessageId', () => {
    const event = buildMessage({
      text: 'thanks',
      reply_to_message: {
        message_id: 7,
        date: 1_700_000_000,
        chat: { id: -100123, type: 'supergroup' },
        from: BOT,
        text: 'sure',
      },
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBe('7')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('reply to a non-bot message surfaces replyToOtherMessageId', () => {
    const event = buildMessage({
      text: 'I disagree',
      reply_to_message: {
        message_id: 8,
        date: 1_700_000_000,
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 2, is_bot: false, first_name: 'Bob' },
        text: 'we should ship it',
      },
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBe('8')
  })

  test('forum topic messages preserve the message_thread_id as `thread`', () => {
    const event = buildMessage({
      message_thread_id: 1234,
      is_topic_message: true,
      chat: { id: -100123, type: 'supergroup', title: 'Eng', is_forum: true },
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1234')
  })

  test('messages with only a document attachment route with a media-summary text', () => {
    const event = buildMessage({
      text: undefined,
      document: { file_id: 'AgADXYZ', file_unique_id: 'unique', file_name: 'spec.pdf', mime_type: 'application/pdf' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Telegram message with document: spec.pdf (application/pdf) file_id=AgADXYZ]')
  })

  test('photo-only messages include the largest photo size and its file_id', () => {
    const event = buildMessage({
      text: undefined,
      photo: [
        { file_id: 'tiny', file_unique_id: 'u1', width: 90, height: 90 },
        { file_id: 'big', file_unique_id: 'u2', width: 1280, height: 960 },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Telegram message with photo: 1280x960 file_id=big]')
  })

  test('caption-only messages keep both caption and media summary', () => {
    const event = buildMessage({
      text: undefined,
      caption: 'see attached',
      document: { file_id: 'AgADABC', file_unique_id: 'u3', file_name: 'log.txt' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('see attached\n[Telegram message with document: log.txt file_id=AgADABC]')
  })
})

describe('telegram-bot classifyInbound — mentionsOthers', () => {
  test('marks mentionsOthers=true when only non-bot users are @-mentioned', () => {
    const event = buildMessage({
      text: 'cc @alice please review',
      entities: [{ type: 'mention', offset: 3, length: 6 }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(true)
  })

  test('marks mentionsOthers=false when the bot is among the mentions', () => {
    const event = buildMessage({
      text: '@alice @typeclaw_bot please weigh in',
      entities: [
        { type: 'mention', offset: 0, length: 6 },
        { type: 'mention', offset: 7, length: 13 },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('marks mentionsOthers=false when no entities are present', () => {
    const event = buildMessage({ text: 'just chatter' })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(false)
  })
})

describe('telegram-bot classifyInbound — author name resolution', () => {
  test('prefers username over first/last name', () => {
    const event = buildMessage({
      from: { id: 1, is_bot: false, first_name: 'Alice', last_name: 'Lee', username: 'al' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorName).toBe('al')
  })

  test('falls back to first+last when username is absent', () => {
    const event = buildMessage({ from: { id: 1, is_bot: false, first_name: 'Alice', last_name: 'Lee' } })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorName).toBe('Alice Lee')
  })

  test('falls back to first_name only when both username and last_name are absent', () => {
    const event = buildMessage({ from: { id: 1, is_bot: false, first_name: 'Alice' } })

    const verdict = classifyInbound(event, baseConfig, BOT)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorName).toBe('Alice')
  })
})
