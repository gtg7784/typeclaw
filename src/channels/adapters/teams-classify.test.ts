import { describe, expect, test } from 'bun:test'

import type { TeamsMention, TeamsRealtimeMessage, TeamsUser } from 'agent-messenger/teams'

import { channelsSchema } from '@/channels/schema'

import type { TeamsChatInfo } from './teams'
import { classifyChannelInbound, classifyChatInbound, normalizeTeamsText } from './teams-classify'

const config = channelsSchema.parse({ teams: {} }).teams!

const SELF: TeamsUser = { id: 'ME', displayName: 'Typeey', userPrincipalName: 'typeey@example.com' }

function event(overrides: Partial<TeamsRealtimeMessage> = {}): TeamsRealtimeMessage {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    conversationType: 'chat',
    // Realtime content arrives already HTML-stripped from the SDK, so tests use
    // plain text (no `<at>` tags) to mirror what the adapter actually receives.
    content: 'hello typeclaw',
    mentions: [],
    author: { id: 'user-1', displayName: 'Alice' },
    messageType: 'RichText/Html',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function mention(displayName: string, mri?: string): TeamsMention {
  return { id: '0', displayName, ...(mri !== undefined ? { mri } : {}) }
}

function chat(overrides: Partial<TeamsChatInfo> = {}): TeamsChatInfo {
  return { id: 'chat-1', type: 'group', ...overrides } as TeamsChatInfo
}

const CHANNEL = { teamId: 'team-guid', channelId: '19:abc@thread.tacv2' }

describe('classifyChatInbound', () => {
  test('drops before self identity resolves', () => {
    expect(classifyChatInbound(event(), config, null, chat())).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('drops when the chat could not be resolved', () => {
    expect(classifyChatInbound(event(), config, SELF, undefined)).toEqual({ kind: 'drop', reason: 'unknown_chat' })
  })

  test('drops an empty message', () => {
    expect(classifyChatInbound(event({ content: '   ' }), config, SELF, chat())).toEqual({
      kind: 'drop',
      reason: 'empty_content',
    })
  })

  test('routes a group message keyed as chat:<chatId> with workspace teams', () => {
    const verdict = classifyChatInbound(event(), config, SELF, chat())
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.adapter).toBe('teams')
    expect(verdict.payload.workspace).toBe('teams')
    expect(verdict.payload.chat).toBe('chat:chat-1')
    expect(verdict.payload.thread).toBeNull()
    expect(verdict.payload.isDm).toBe(false)
    expect(verdict.payload.authorId).toBe('user-1')
    expect(verdict.payload.text).toBe('hello typeclaw')
  })

  test('marks oneOnOne chats as DMs and never fails closed', () => {
    const verdict = classifyChatInbound(event(), config, SELF, chat({ type: 'oneOnOne' }))
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
    expect(verdict.payload.suppressSticky).toBe(false)
  })

  test('marks self chats as DMs', () => {
    const verdict = classifyChatInbound(event(), config, SELF, chat({ type: 'self' }))
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isDm).toBe(true)
  })

  test('engages a group message on a plain-text alias match', () => {
    const verdict = classifyChatInbound(event({ content: 'typeclaw are you there' }), config, SELF, chat(), [
      'typeclaw',
    ])
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('engages on a structured mention of the bot display name', () => {
    const verdict = classifyChatInbound(
      event({ content: 'please help', mentions: [mention('Typeey', '8:orgid:self')] }),
      config,
      SELF,
      chat(),
    )
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('fails a group message closed when only someone else is mentioned', () => {
    const verdict = classifyChatInbound(
      event({ content: 'hey look', mentions: [mention('Bob', '8:orgid:bob')] }),
      config,
      SELF,
      chat(),
      ['typeclaw'],
    )
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.mentionsOthers).toBe(true)
    expect(verdict.payload.suppressSticky).toBe(true)
  })

  test('does not treat a mention that merely CONTAINS the bot name as addressing the bot', () => {
    // given the bot alias is "bot" and someone mentions a different user "Build Bot"
    const verdict = classifyChatInbound(
      event({ content: 'ping the pipeline', mentions: [mention('Build Bot', '8:orgid:ci')] }),
      config,
      SELF,
      chat(),
      ['bot'],
    )
    // then the structured mention must NOT match (exact, not substring) and the
    // message fails closed
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.mentionsOthers).toBe(true)
    expect(verdict.payload.suppressSticky).toBe(true)
  })

  test('an aliased group message does not suppress sticky', () => {
    const verdict = classifyChatInbound(event({ content: 'typeclaw please help' }), config, SELF, chat(), ['typeclaw'])
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.suppressSticky).toBe(false)
  })

  test('a DM never suppresses sticky', () => {
    const verdict = classifyChatInbound(event({ content: 'no alias' }), config, SELF, chat({ type: 'oneOnOne' }))
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.suppressSticky).toBe(false)
  })

  test('routes a non-Latin (Korean) group message with a Korean alias match', () => {
    // given a Korean-script inbound that names the bot by its Korean alias
    const verdict = classifyChatInbound(event({ content: '타이피 확인 부탁해요' }), config, SELF, chat(), ['타이피'])
    // then the alias still matches (script-agnostic) and the text is preserved
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
    expect(verdict.payload.text).toBe('타이피 확인 부탁해요')
  })

  test('carries a zero ts when the timestamp is unparseable', () => {
    const verdict = classifyChatInbound(event({ timestamp: 'not-a-date' }), config, SELF, chat())
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.ts).toBe(0)
  })
})

describe('classifyChannelInbound', () => {
  const channelEvent = (overrides: Partial<TeamsRealtimeMessage> = {}) =>
    event({
      conversationType: 'channel',
      chatId: CHANNEL.channelId,
      teamId: CHANNEL.teamId,
      channelId: CHANNEL.channelId,
      ...overrides,
    })

  test('routes a channel message keyed as channel:<teamId>:<channelId>, never a DM', () => {
    const verdict = classifyChannelInbound(channelEvent(), config, SELF, CHANNEL, ['typeclaw'])
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.chat).toBe('channel:team-guid:19:abc@thread.tacv2')
    expect(verdict.payload.isDm).toBe(false)
  })

  test('engages a channel message on a structured mention of the bot', () => {
    const verdict = classifyChannelInbound(
      channelEvent({ content: 'deploy please', mentions: [mention('Typeey', '8:orgid:self')] }),
      config,
      SELF,
      CHANNEL,
    )
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
    expect(verdict.payload.suppressSticky).toBe(false)
  })

  test('fails an unaddressed channel message closed', () => {
    const verdict = classifyChannelInbound(channelEvent({ content: 'general chatter' }), config, SELF, CHANNEL, [
      'typeclaw',
    ])
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.mentionsOthers).toBe(true)
    expect(verdict.payload.suppressSticky).toBe(true)
  })

  test('drops before self identity resolves', () => {
    expect(classifyChannelInbound(channelEvent(), config, null, CHANNEL)).toEqual({
      kind: 'drop',
      reason: 'pre_connect',
    })
  })
})

describe('normalizeTeamsText', () => {
  test('collapses whitespace and trims', () => {
    expect(normalizeTeamsText('  hello   world \n')).toBe('hello world')
  })
})
