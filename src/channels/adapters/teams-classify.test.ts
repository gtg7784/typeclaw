import { describe, expect, test } from 'bun:test'

import type { TeamsRealtimeMessage, TeamsUser } from 'agent-messenger/teams'

import { channelsSchema } from '@/channels/schema'

import type { TeamsChatInfo } from './teams'
import { classifyInbound, normalizeTeamsText } from './teams-classify'

const config = channelsSchema.parse({ teams: {} }).teams!

const SELF: TeamsUser = { id: 'ME', displayName: 'Typeey', userPrincipalName: 'typeey@example.com' }

function event(overrides: Partial<TeamsRealtimeMessage> = {}): TeamsRealtimeMessage {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    // Realtime content arrives already HTML-stripped from the SDK, so tests use
    // plain text (no `<at>` tags) to mirror what the adapter actually receives.
    content: 'hello typeclaw',
    author: { id: 'user-1', displayName: 'Alice' },
    messageType: 'RichText/Html',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function chat(overrides: Partial<TeamsChatInfo> = {}): TeamsChatInfo {
  return { id: 'chat-1', type: 'group', ...overrides } as TeamsChatInfo
}

describe('classifyInbound', () => {
  test('drops before self identity resolves', () => {
    expect(classifyInbound(event(), config, null, chat())).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('drops when the chat could not be resolved', () => {
    expect(classifyInbound(event(), config, SELF, undefined)).toEqual({ kind: 'drop', reason: 'unknown_chat' })
  })

  test('drops an empty message', () => {
    expect(classifyInbound(event({ content: '   ' }), config, SELF, chat())).toEqual({
      kind: 'drop',
      reason: 'empty_content',
    })
  })

  test('routes a group message keyed as chat:<chatId> with workspace teams', () => {
    const verdict = classifyInbound(event(), config, SELF, chat())
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.adapter).toBe('teams')
    expect(verdict.payload.workspace).toBe('teams')
    expect(verdict.payload.chat).toBe('chat:chat-1')
    expect(verdict.payload.thread).toBeNull()
    expect(verdict.payload.isDm).toBe(false)
    expect(verdict.payload.authorId).toBe('user-1')
    expect(verdict.payload.authorName).toBe('Alice')
    expect(verdict.payload.text).toBe('hello typeclaw')
  })

  test('marks oneOnOne chats as DMs and never sets mentionsOthers', () => {
    const verdict = classifyInbound(event(), config, SELF, chat({ type: 'oneOnOne' }))
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('marks self chats as DMs', () => {
    const verdict = classifyInbound(event(), config, SELF, chat({ type: 'self' }))
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isDm).toBe(true)
  })

  test('engages a group message on a plain-text alias match', () => {
    const verdict = classifyInbound(event({ content: 'typeclaw are you there' }), config, SELF, chat(), ['typeclaw'])
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('fails a group message closed when no alias matches (solo + sticky suppressed)', () => {
    const verdict = classifyInbound(event({ content: 'just chatting' }), config, SELF, chat(), ['typeclaw'])
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.mentionsOthers).toBe(true)
    expect(verdict.payload.suppressSticky).toBe(true)
  })

  test('an aliased group message does not suppress sticky', () => {
    const verdict = classifyInbound(event({ content: 'typeclaw please help' }), config, SELF, chat(), ['typeclaw'])
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.suppressSticky).toBe(false)
  })

  test('a DM never suppresses sticky', () => {
    const verdict = classifyInbound(event({ content: 'no alias' }), config, SELF, chat({ type: 'oneOnOne' }))
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.suppressSticky).toBe(false)
  })

  test('routes a non-Latin (Korean) group message with a Korean alias match', () => {
    // given a Korean-script inbound that names the bot by its Korean alias
    const verdict = classifyInbound(event({ content: '타이피 확인 부탁해요' }), config, SELF, chat(), ['타이피'])
    // then the alias still matches (script-agnostic) and the text is preserved
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
    expect(verdict.payload.text).toBe('타이피 확인 부탁해요')
  })

  test('carries a zero ts when the timestamp is unparseable', () => {
    const verdict = classifyInbound(event({ timestamp: 'not-a-date' }), config, SELF, chat())
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.ts).toBe(0)
  })
})

describe('normalizeTeamsText', () => {
  test('collapses whitespace and trims', () => {
    expect(normalizeTeamsText('  hello   world \n')).toBe('hello world')
  })
})
