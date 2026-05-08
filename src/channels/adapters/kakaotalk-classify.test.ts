import { describe, expect, test } from 'bun:test'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import type { KakaoTalkPushMessageEvent } from './agent-messenger-kakaotalk-shim'
import { classifyInbound, type KakaoChatLookup } from './kakaotalk-classify'

const dmConfig = (): ChannelAdapterConfig => ({
  allow: ['kakao:dm/*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
})

const groupConfig = (): ChannelAdapterConfig => ({
  allow: ['kakao:group/*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
})

const event = (overrides: Partial<KakaoTalkPushMessageEvent> = {}): KakaoTalkPushMessageEvent => ({
  type: 'MSG',
  chat_id: '111',
  log_id: 'L1',
  author_id: 222,
  message: 'hello',
  message_type: 1,
  sent_at: 1_730_000_000_000,
  ...overrides,
})

const dmLookup: KakaoChatLookup = (id) => (id === '111' ? { workspace: '@kakao-dm', isDm: true } : null)
const groupLookup: KakaoChatLookup = (id) => (id === '111' ? { workspace: '@kakao-group', isDm: false } : null)

describe('classifyInbound', () => {
  test('drops pre_connect when selfUserId is null', () => {
    const verdict = classifyInbound(event(), dmConfig(), { selfUserId: null, lookupChat: dmLookup })
    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('drops self_author when authored by self', () => {
    const verdict = classifyInbound(event({ author_id: 999 }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops empty_text when message is empty', () => {
    const verdict = classifyInbound(event({ message: '' }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_text' })
  })

  test('drops unknown_chat when lookup returns null', () => {
    const verdict = classifyInbound(event(), dmConfig(), {
      selfUserId: '999',
      lookupChat: () => null,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'unknown_chat' })
  })

  test('drops not_in_allow_list when chat is in a bucket the rules do not admit', () => {
    const verdict = classifyInbound(event(), dmConfig(), {
      selfUserId: '999',
      lookupChat: groupLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'not_in_allow_list' })
  })

  test('routes a 1:1 message and stamps the dm workspace + isDm', () => {
    const verdict = classifyInbound(event(), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
    })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.adapter).toBe('kakaotalk')
    expect(verdict.payload.workspace).toBe('@kakao-dm')
    expect(verdict.payload.chat).toBe('111')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.thread).toBeNull()
    expect(verdict.payload.text).toBe('hello')
    expect(verdict.payload.externalMessageId).toBe('L1')
    expect(verdict.payload.authorId).toBe('222')
    expect(verdict.payload.ts).toBe(1_730_000_000_000)
    expect(verdict.payload.authorIsBot).toBe(false)
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('routes a group message and marks isDm=false', () => {
    const verdict = classifyInbound(event(), groupConfig(), {
      selfUserId: '999',
      lookupChat: groupLookup,
    })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.workspace).toBe('@kakao-group')
    expect(verdict.payload.isDm).toBe(false)
  })

  test('alias match in text sets isBotMention=true', () => {
    const verdict = classifyInbound(event({ message: 'hey claudie, are you there?' }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
      selfAliases: ['claudie'],
    })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('absent alias keeps isBotMention=false on plain message', () => {
    const verdict = classifyInbound(event({ message: 'random thought' }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
      selfAliases: ['claudie'],
    })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.isBotMention).toBe(false)
  })
})
