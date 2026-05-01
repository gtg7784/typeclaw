import { describe, expect, test } from 'bun:test'

import type { ChannelAdapterConfig } from '@/channels/schema'

import type { SlackSocketMessageEvent } from './agent-messenger-slack-shim'
import { classifyInbound } from './slack-bot-classify'

const TEAM_ID = 'T0ACME'
const BOT_USER_ID = 'UBOT'

const baseConfig: ChannelAdapterConfig = {
  allow: ['*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
}

function buildEvent(overrides: Partial<SlackSocketMessageEvent> = {}): SlackSocketMessageEvent {
  return {
    type: 'message',
    channel: 'C0CHANNEL',
    channel_type: 'channel',
    user: 'UALICE',
    text: 'hello',
    ts: '1700000000.000100',
    ...overrides,
  }
}

describe('slack-bot classifyInbound — drop paths', () => {
  test('drops messages with bot_id set with reason=bot_author', () => {
    const event = buildEvent({ bot_id: 'B12345' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_author' })
  })

  test('drops bot_message subtype with reason=bot_author', () => {
    const event = buildEvent({ subtype: 'bot_message' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_author' })
  })

  test('drops messages from the bot itself with reason=bot_author', () => {
    const event = buildEvent({ user: BOT_USER_ID })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_author' })
  })

  test('drops events with no user (e.g. system events) with reason=no_user', () => {
    const event = buildEvent({ user: undefined })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'no_user' })
  })

  test('drops empty-text messages with reason=empty_text', () => {
    const event = buildEvent({ text: '' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_text' })
  })

  test('drops messages from a team not in the allow list with reason=not_in_allow_list', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: ['team:T0OTHER'] }
    const event = buildEvent()

    const verdict = classifyInbound(event, config, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'not_in_allow_list' })
  })

  test('drops a DM when allow list only covers team channels', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: ['team:*'] }
    const event = buildEvent({ channel_type: 'im', channel: 'D0DMID' })

    const verdict = classifyInbound(event, config, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'not_in_allow_list' })
  })

  test('bot_author wins over allow filtering (drop reasons checked first)', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: [] }
    const event = buildEvent({ subtype: 'bot_message' })

    const verdict = classifyInbound(event, config, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_author' })
  })
})

describe('slack-bot classifyInbound — route path', () => {
  test('routes a top-level team channel mention into a thread rooted at that message', () => {
    const event = buildEvent({ text: `hi <@${BOT_USER_ID}>` })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toEqual({
      adapter: 'slack-bot',
      workspace: TEAM_ID,
      chat: 'C0CHANNEL',
      thread: '1700000000.000100',
      text: `hi <@${BOT_USER_ID}>`,
      externalMessageId: '1700000000.000100',
      authorId: 'UALICE',
      authorName: 'UALICE',
      isBotMention: true,
      replyToBotMessageId: null,
      isDm: false,
    })
  })

  test('non-mention team messages route with isBotMention=false', () => {
    const event = buildEvent({ text: 'good morning team' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.thread).toBeNull()
  })

  test('DMs (channel_type=im) route with workspace=@dm and isDm=true', () => {
    const event = buildEvent({ channel_type: 'im', channel: 'D0DMID', text: 'private hi' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({ workspace: '@dm', chat: 'D0DMID', isDm: true })
  })

  test('thread reply surfaces thread_ts as thread and replyToBotMessageId when ts differs', () => {
    const event = buildEvent({
      text: 'thanks',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.replyToBotMessageId).toBe('1700000000.000100')
  })

  test('parent message of a thread (ts === thread_ts) does not register as a reply', () => {
    const event = buildEvent({
      text: 'starting a thread',
      ts: '1700000000.000100',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
  })

  test('treats every event as a mention while botUserId is unknown (pre-connected race window)', () => {
    const event = buildEvent({ text: 'no explicit mention' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: null })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.replyToBotMessageId).toBeNull()
  })

  test('drops replyToBotMessageId before bot identity is known (cannot be sure parent was ours)', () => {
    const event = buildEvent({
      text: 'reply',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: null })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
  })
})
