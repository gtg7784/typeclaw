import { describe, expect, test } from 'bun:test'

import type { ChannelParticipant } from '@/agent/session-origin'

import { decideEngagement, grantStickyForReplyTargets, StickyLedger } from './engagement'
import type { EngagementConfig } from './schema'
import type { InboundMessage } from './types'

const KEY = 'discord-bot:g1:c1:'

const baseConfig: EngagementConfig = {
  trigger: ['mention', 'reply', 'dm'],
  stickiness: { perReply: { window: 5 * 60 * 1000 } },
}

function participant(authorId: string, lastMessageAt = 0): ChannelParticipant {
  return {
    authorId,
    authorName: authorId,
    firstMessageAt: lastMessageAt,
    lastMessageAt,
    messageCount: 1,
  }
}

const crowded: readonly ChannelParticipant[] = [participant('alice'), participant('bob')]

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: 'discord-bot',
    workspace: 'g1',
    chat: 'c1',
    thread: null,
    text: 'hi',
    externalMessageId: 'm1',
    authorId: 'alice',
    authorName: 'alice',
    isBotMention: false,
    replyToBotMessageId: null,
    isDm: false,
    ...over,
  }
}

describe('decideEngagement (explicit triggers)', () => {
  test('mention engages when trigger includes mention', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isBotMention: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('mention does not engage if trigger excludes mention', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isBotMention: true }),
      config: { trigger: ['reply', 'dm'], stickiness: 'off' },
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('observe')
  })

  test('reply to bot engages when trigger includes reply', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ replyToBotMessageId: 'msg42' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('DM engages when trigger includes dm', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isDm: true, workspace: '@dm' }),
      config: baseConfig,
      key: 'discord-bot:@dm:d1:',
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('plain message in crowded channel observes', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('observe')
  })
})

describe('decideEngagement (sticky)', () => {
  test('sticky credit consumed engages a follow-up message', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 500,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('sticky credit is consumed (single message)', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    decideEngagement({ message: inbound(), config: baseConfig, key: KEY, ledger, now: 100, participants: crowded })
    const second = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 200,
      participants: crowded,
    })
    expect(second).toBe('observe')
  })

  test('expired sticky credit does not engage and is consumed', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 5000,
      participants: crowded,
    })
    expect(decision).toBe('observe')
    expect(ledger.has(KEY, 'alice', 5000)).toBe(false)
  })

  test('sticky off makes follow-ups observe even with prior credits', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    const decision = decideEngagement({
      message: inbound(),
      config: { trigger: ['mention'], stickiness: 'off' },
      key: KEY,
      ledger,
      now: 100,
      participants: crowded,
    })
    expect(decision).toBe('observe')
  })

  test('sticky is per-author (alice has credit, bob does not)', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    expect(
      decideEngagement({
        message: inbound({ authorId: 'bob' }),
        config: baseConfig,
        key: KEY,
        ledger,
        now: 100,
        participants: crowded,
      }),
    ).toBe('observe')
  })
})

describe('decideEngagement (solo-human fallback)', () => {
  test('engages on plain message when channel has only the current sender', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
  })

  test('engages even when triggers exclude mention/reply/dm (allow-only setup)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: { trigger: [], stickiness: 'off' },
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
  })

  test('engages on first-ever message before participants is updated', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [],
    })
    expect(decision).toBe('engage')
  })

  test('does NOT engage on plain message once a second human posts', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), participant('bob')],
    })
    expect(decision).toBe('observe')
  })
})

describe('grantStickyForReplyTargets', () => {
  test('grants credit per author when stickiness is on', () => {
    const ledger = new StickyLedger()
    grantStickyForReplyTargets(ledger, KEY, ['alice', 'bob'], baseConfig, 1000)
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
    expect(ledger.has(KEY, 'bob', 1000)).toBe(true)
  })

  test('does not grant when stickiness is off', () => {
    const ledger = new StickyLedger()
    grantStickyForReplyTargets(ledger, KEY, ['alice'], { trigger: ['mention'], stickiness: 'off' }, 1000)
    expect(ledger.has(KEY, 'alice', 1000)).toBe(false)
  })

  test('granted credit expires after the configured window', () => {
    const ledger = new StickyLedger()
    grantStickyForReplyTargets(ledger, KEY, ['alice'], baseConfig, 0)
    expect(
      ledger.has(KEY, 'alice', baseConfig.stickiness === 'off' ? 0 : baseConfig.stickiness.perReply.window - 1),
    ).toBe(true)
    expect(
      ledger.has(KEY, 'alice', baseConfig.stickiness === 'off' ? 0 : baseConfig.stickiness.perReply.window + 1),
    ).toBe(false)
  })
})
