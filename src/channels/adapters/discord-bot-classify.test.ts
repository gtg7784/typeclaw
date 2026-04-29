import { describe, expect, test } from 'bun:test'

import type { ChannelAdapterConfig } from '@/channels/schema'

import type { DiscordGatewayMessageCreateEvent } from './agent-messenger-shim'
import { classifyInbound } from './discord-bot-classify'

const BOT_USER_ID = '999'

const baseConfig: ChannelAdapterConfig = {
  allow: ['*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
}

function buildEvent(overrides: Partial<DiscordGatewayMessageCreateEvent> = {}): DiscordGatewayMessageCreateEvent {
  return {
    type: 'MESSAGE_CREATE',
    id: 'm1',
    channel_id: 'c1',
    guild_id: 'g1',
    author: { id: 'u1', username: 'alice', bot: false },
    content: 'hello',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('classifyInbound — drop paths', () => {
  test('drops bot-authored messages with reason=bot_author', () => {
    const event = buildEvent({ author: { id: 'u1', username: 'bot', bot: true } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_author' })
  })

  test('drops empty-content messages with reason=empty_content (missing MessageContent intent)', () => {
    const event = buildEvent({ content: '' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_content' })
  })

  test('drops messages from a workspace not in the allow list with reason=not_in_allow_list', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: ['guild:other'] }
    const event = buildEvent({ guild_id: 'g1' })

    const verdict = classifyInbound(event, config, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'not_in_allow_list' })
  })

  test('drops a DM when allow list only covers guild channels', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: ['guild:*'] }
    const event = buildEvent({ guild_id: undefined, channel_id: 'dm1' })

    const verdict = classifyInbound(event, config, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'not_in_allow_list' })
  })

  test('drop reasons are checked before allow list (bot_author wins over allow filtering)', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: [] }
    const event = buildEvent({ author: { id: 'u1', username: 'bot', bot: true } })

    const verdict = classifyInbound(event, config, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_author' })
  })
})

describe('classifyInbound — route path', () => {
  test('routes a guild message that contains a bot mention', () => {
    const event = buildEvent({ content: `hi <@${BOT_USER_ID}>` })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toEqual({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
      text: `hi <@${BOT_USER_ID}>`,
      externalMessageId: 'm1',
      authorId: 'u1',
      authorName: 'alice',
      isBotMention: true,
      replyToBotMessageId: null,
      isDm: false,
    })
  })

  test('detects nickname-form mentions <@!id> as bot mentions', () => {
    const event = buildEvent({ content: `hey <@!${BOT_USER_ID}> ping` })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('non-mention guild messages route with isBotMention=false', () => {
    const event = buildEvent({ content: 'good morning team' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('DMs route with workspace=@dm and isDm=true', () => {
    const event = buildEvent({ guild_id: undefined, channel_id: 'dm1', content: 'private hi' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({ workspace: '@dm', chat: 'dm1', isDm: true })
  })

  test('reply to bot message surfaces replyToBotMessageId', () => {
    const event = buildEvent({
      content: 'thanks',
      message_reference: { message_id: 'parent-1', channel_id: 'c1' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBe('parent-1')
  })

  test('treats every event as a mention while botUserId is unknown (pre-connected race window)', () => {
    const event = buildEvent({ content: 'no explicit mention' })

    const verdict = classifyInbound(event, baseConfig, null)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.replyToBotMessageId).toBeNull()
  })

  test('drops replyToBotMessageId before bot identity is known (cannot be sure parent was ours)', () => {
    const event = buildEvent({
      content: 'reply',
      message_reference: { message_id: 'parent-1' },
    })

    const verdict = classifyInbound(event, baseConfig, null)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
  })
})
