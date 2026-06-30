import { describe, expect, test } from 'bun:test'

import type { InstagramMessageSummary } from 'agent-messenger/instagram'

import type { ChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound, type InstagramChatLookup } from './instagram-classify'

const CONFIG = {} as ChannelAdapterConfig

function message(overrides: Partial<InstagramMessageSummary> = {}): InstagramMessageSummary {
  return {
    id: 'M1',
    thread_id: 'T1',
    from: 'U_other',
    from_name: 'Alice',
    timestamp: '2025-01-02T03:04:05.000Z',
    is_outgoing: false,
    type: 'text',
    text: 'hello',
    ...overrides,
  }
}

const dmLookup: InstagramChatLookup = (id) => (id === 'T1' ? { workspace: '@instagram-dm', isDm: true } : null)
const groupLookup: InstagramChatLookup = (id) => (id === 'T1' ? { workspace: '@instagram-group', isDm: false } : null)

describe('classifyInbound', () => {
  test('drops before self id is known', () => {
    expect(classifyInbound(message(), CONFIG, { selfUserId: null, lookupChat: dmLookup })).toEqual({
      kind: 'drop',
      reason: 'pre_connect',
    })
  })

  test('drops outgoing and self-authored messages', () => {
    expect(
      classifyInbound(message({ is_outgoing: true }), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup }),
    ).toEqual({
      kind: 'drop',
      reason: 'self_author',
    })
    expect(
      classifyInbound(message({ from: 'U_self' }), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup }),
    ).toEqual({
      kind: 'drop',
      reason: 'self_author',
    })
  })

  test('drops empty text with no media and unknown chats', () => {
    expect(
      classifyInbound(message({ text: undefined }), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup }),
    ).toEqual({
      kind: 'drop',
      reason: 'empty_text',
    })
    expect(
      classifyInbound(message({ thread_id: 'missing' }), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup }),
    ).toEqual({
      kind: 'drop',
      reason: 'unknown_chat',
    })
  })

  test('routes media-only messages with a plain-text placeholder', () => {
    const verdict = classifyInbound(
      message({ text: undefined, type: 'reel_share', media_url: 'https://example.test/reel' }),
      CONFIG,
      {
        selfUserId: 'U_self',
        lookupChat: dmLookup,
      },
    )
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Instagram reel_share]')
  })

  test('routes DMs and parses timestamps', () => {
    const verdict = classifyInbound(message(), CONFIG, { selfUserId: 'U_self', lookupChat: dmLookup })
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.adapter).toBe('instagram')
    expect(verdict.payload.workspace).toBe('@instagram-dm')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.ts).toBe(Date.parse('2025-01-02T03:04:05.000Z'))
  })

  test('marks English and Korean alias hits in groups', () => {
    const english = classifyInbound(message({ text: 'hey claude' }), CONFIG, {
      selfUserId: 'U_self',
      lookupChat: groupLookup,
      selfAliases: ['claude'],
    })
    if (english.kind !== 'route') throw new Error('expected route')
    expect(english.payload.isBotMention).toBe(true)

    const korean = classifyInbound(message({ text: '확인 부탁해요' }), CONFIG, {
      selfUserId: 'U_self',
      lookupChat: groupLookup,
      selfAliases: ['확인'],
    })
    if (korean.kind !== 'route') throw new Error('expected route')
    expect(korean.payload.isBotMention).toBe(true)
  })

  test('degrades malformed timestamps to 0', () => {
    const verdict = classifyInbound(message({ timestamp: 'bad' }), CONFIG, {
      selfUserId: 'U_self',
      lookupChat: dmLookup,
    })
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.ts).toBe(0)
  })
})
