import { describe, expect, test } from 'bun:test'

import type { KakaoTalkPushMessageEvent } from 'agent-messenger/kakaotalk'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound, type KakaoChatLookup } from './kakaotalk-classify'

const dmConfig = (): ChannelAdapterConfig => ({
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
})

const groupConfig = (): ChannelAdapterConfig => ({
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
  author_name: null,
  message: 'hello',
  message_type: 1,
  attachment: null,
  sent_at: 1_730_000_000,
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

  test('drops bot_message when LOCO message_type=71 (kakao notification feed)', () => {
    const verdict = classifyInbound(
      event({ message_type: 71, author_id: 406180744, author_name: '카카오 고객센터', message: '시스템 알림' }),
      groupConfig(),
      { selfUserId: '999', lookupChat: groupLookup },
    )
    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_message' })
  })

  test('bot_message drop wins over unknown_chat (independent of resolver state)', () => {
    const verdict = classifyInbound(event({ message_type: 71 }), groupConfig(), {
      selfUserId: '999',
      lookupChat: () => null,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_message' })
  })

  test('self_author still wins over bot_message (defense in depth)', () => {
    const verdict = classifyInbound(event({ message_type: 71, author_id: 999 }), groupConfig(), {
      selfUserId: '999',
      lookupChat: groupLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('normal text (message_type=1) is not dropped as bot_message', () => {
    const verdict = classifyInbound(event({ message_type: 1 }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
    })
    expect(verdict.kind).toBe('route')
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
    expect(new Date(verdict.payload.ts).getUTCFullYear()).toBe(2024)
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
