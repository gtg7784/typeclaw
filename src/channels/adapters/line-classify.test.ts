import { describe, expect, test } from 'bun:test'

import type { LinePushMessageEvent } from 'agent-messenger/line'

import type { ChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound, type LineChatLookup } from './line-classify'

const CONFIG = {} as ChannelAdapterConfig

function event(overrides: Partial<LinePushMessageEvent> = {}): LinePushMessageEvent {
  return {
    type: 'message',
    chat_id: 'C1',
    message_id: 'M1',
    author_id: 'U_other',
    text: 'hello',
    content_type: 'text',
    sent_at: '2025-01-02T03:04:05.000Z',
    ...overrides,
  }
}

const dmLookup: LineChatLookup = (id) => (id === 'C1' ? { workspace: '@line-dm', isDm: true } : null)
const groupLookup: LineChatLookup = (id) => (id === 'C1' ? { workspace: '@line-group', isDm: false } : null)

describe('classifyInbound', () => {
  test('drops before the self id is known', () => {
    const verdict = classifyInbound(event(), CONFIG, { selfUserId: null, lookupChat: dmLookup })
    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('drops messages authored by the bot itself', () => {
    const verdict = classifyInbound(event({ author_id: 'U_self' }), CONFIG, {
      selfUserId: 'U_self',
      lookupChat: dmLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops empty-text messages', () => {
    const verdict = classifyInbound(event({ text: null }), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup })
    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_text' })
  })

  test('drops messages from chats not yet in the resolver', () => {
    const verdict = classifyInbound(event({ chat_id: 'C_unknown' }), CONFIG, {
      selfUserId: 'U_self',
      lookupChat: dmLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'unknown_chat' })
  })

  test('routes a DM with isDm true and no mention without aliases', () => {
    const verdict = classifyInbound(event(), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.adapter).toBe('line')
    expect(verdict.payload.workspace).toBe('@line-dm')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.authorIsBot).toBe(false)
    expect(verdict.payload.externalMessageId).toBe('M1')
  })

  test('marks an alias hit as a bot mention in a group', () => {
    const verdict = classifyInbound(event({ text: 'hey claude can you help' }), CONFIG, {
      selfUserId: 'U_self',
      lookupChat: groupLookup,
      selfAliases: ['claude'],
    })
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.workspace).toBe('@line-group')
    expect(verdict.payload.isDm).toBe(false)
  })

  test('uses the resolved author name, falling back to author id', () => {
    const named = classifyInbound(event(), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup, authorName: 'Alice' })
    if (named.kind !== 'route') throw new Error('expected route')
    expect(named.payload.authorName).toBe('Alice')

    const unnamed = classifyInbound(event(), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup })
    if (unnamed.kind !== 'route') throw new Error('expected route')
    expect(unnamed.payload.authorName).toBe('U_other')
  })

  test('parses the ISO sent_at into epoch milliseconds', () => {
    const verdict = classifyInbound(event({ sent_at: '2025-01-02T03:04:05.000Z' }), CONFIG, {
      selfUserId: 'U_self',
      lookupChat: dmLookup,
    })
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.ts).toBe(Date.parse('2025-01-02T03:04:05.000Z'))
  })

  test('degrades a malformed sent_at to 0 (unknown) instead of NaN', () => {
    const verdict = classifyInbound(event({ sent_at: 'not-a-date' }), CONFIG, {
      selfUserId: 'U_self',
      lookupChat: dmLookup,
    })
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.ts).toBe(0)
  })
})
