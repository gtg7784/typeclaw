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
  test('drops self-authored messages (author.id === botUserId) with reason=self_author', () => {
    const event = buildEvent({ author: { id: BOT_USER_ID, username: 'me', bot: true } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops empty-content messages with reason=empty_content (missing MessageContent intent)', () => {
    const event = buildEvent({ content: '' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_content' })
  })

  test('routes media-only messages with attachment metadata instead of treating them as missing intent', () => {
    const event = buildEvent({
      content: '',
      attachments: [
        {
          id: 'a1',
          filename: 'diagram.png',
          url: 'https://cdn.discordapp.com/attachments/c1/a1/diagram.png',
          content_type: 'image/png',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe(
      '[Discord message with attachment: diagram.png (image/png) https://cdn.discordapp.com/attachments/c1/a1/diagram.png]',
    )
  })

  test('routes sticker-only messages because Discord exposes sticker metadata without MessageContent intent', () => {
    const event = buildEvent({
      content: '',
      sticker_items: [{ id: 's1', name: 'party parrot', format_type: 1 }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Discord message with sticker: party parrot]')
  })

  test('routes embed-only messages with embed metadata when Discord provides it', () => {
    const event = buildEvent({
      content: '',
      embeds: [{ type: 'rich', title: 'Release notes', url: 'https://example.com/releases' }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Discord message with embed: Release notes https://example.com/releases]')
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

  test('drop reasons are checked before allow list (self_author wins over allow filtering)', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: [] }
    const event = buildEvent({ author: { id: BOT_USER_ID, username: 'me', bot: true } })

    const verdict = classifyInbound(event, config, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })
})

describe('classifyInbound — peer-bot routing', () => {
  test('routes a peer bot message with authorIsBot=true', () => {
    const event = buildEvent({
      author: { id: 'peer-bot-id', username: 'peer-bot', bot: true },
      content: 'I am another bot speaking',
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(true)
    expect(verdict.payload.authorId).toBe('peer-bot-id')
  })

  test('routes a human message with authorIsBot=false', () => {
    const event = buildEvent({ author: { id: 'u1', username: 'alice', bot: false } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(false)
  })

  test('still drops self even when bot flag is set (self check comes first)', () => {
    const event = buildEvent({ author: { id: BOT_USER_ID, username: 'me', bot: true } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
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
      authorIsBot: false,
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
