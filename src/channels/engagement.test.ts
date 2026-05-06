import { describe, expect, test } from 'bun:test'

import type { ChannelParticipant } from '@/agent/session-origin'

import {
  decideEngagement as decideEngagementRaw,
  grantStickyForReplyTargets,
  resolveEffectiveHumans,
  StickyLedger,
  type EngagementInput,
} from './engagement'
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

function decideEngagement(
  input: Omit<EngagementInput, 'membership' | 'selfAliases'> &
    Partial<Pick<EngagementInput, 'membership' | 'selfAliases'>>,
): ReturnType<typeof decideEngagementRaw> {
  return decideEngagementRaw({ membership: null, selfAliases: [], ...input })
}

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
    authorIsBot: false,
    isBotMention: false,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts: 0,
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

describe('decideEngagement (alias)', () => {
  test('engages when text contains a self-alias (case-insensitive)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: '봉봉아 cron 좀 봐줘' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['봉봉'],
    })
    expect(decision).toBe('engage')
  })

  test('engages on Latin alias regardless of case', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: 'Hey BONGBONG, deploy please' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['bongbong'],
    })
    expect(decision).toBe('engage')
  })

  test('observes when text does not contain any self-alias', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: 'general chatter, not addressed' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['봉봉', 'bongbong'],
    })
    expect(decision).toBe('observe')
  })

  test('empty alias list is a no-op (preserves prior behavior)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: '봉봉아 cron 좀 봐줘' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: [],
    })
    expect(decision).toBe('observe')
  })

  test('alias engagement is NOT suppressed by mentionsOthers', () => {
    // The user can address two bots in one message; both should engage on
    // their own alias matches. Suppressing on mentionsOthers would break
    // multi-target addressing.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: '봉봉아 펭펭아 둘 다 봐', mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['봉봉'],
    })
    expect(decision).toBe('engage')
  })

  test('matches any alias in the list (multi-name agents)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: 'Hey Bongbong, what time?' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['봉봉', 'bongbong', 'bb'],
    })
    expect(decision).toBe('engage')
  })

  test('alias engagement runs after explicit triggers (mention still wins for sticky-credit grant)', () => {
    // Sanity: alias path doesn't break existing trigger ordering. A
    // message with both <@id> mention AND alias text engages, same as
    // mention-only would.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isBotMention: true, text: '<@123> 봉봉아 cron' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['봉봉'],
    })
    expect(decision).toBe('engage')
  })

  test('alias engagement does NOT consume sticky credit when alias path fires', () => {
    // Alias engagement runs after sticky check. If sticky credit exists
    // and alias also matches, sticky check wins first and consumes the
    // credit — no double-engage, no leaked credit.
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    decideEngagement({
      message: inbound({ text: '봉봉아 cron' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
      selfAliases: ['봉봉'],
    })
    expect(ledger.has(KEY, 'alice', 1000)).toBe(false)
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

  test('keeps solo-human fallback even when peer bots are also participants', () => {
    // given
    const ledger = new StickyLedger()
    const peerBots: ChannelParticipant[] = [
      { ...participant('peer1'), isBot: true },
      { ...participant('peer2'), isBot: true },
      { ...participant('peer3'), isBot: true },
    ]

    // when
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), ...peerBots],
    })

    // then
    expect(decision).toBe('engage')
  })

  test('peer bot does NOT ride the solo-human fallback (prevents bot-to-bot loops)', () => {
    // given a 1-human + N-bot channel where another peer bot just spoke
    const ledger = new StickyLedger()
    const participants: ChannelParticipant[] = [
      participant('alice'),
      { ...participant('peer1'), isBot: true },
      { ...participant('peer2'), isBot: true },
    ]

    // when peer1 posts something that does NOT mention/reply to us
    const decision = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
    })

    // then we observe — the fallback is for humans, not bots
    expect(decision).toBe('observe')
  })

  test('peer bot still engages on explicit mention even in solo-human channel', () => {
    // The fallback fix must NOT firewall bots behind extra gates. Symmetric
    // triggers are part of the design contract (see PHILOSOPHY block in
    // engagement.ts) — a peer bot's @-mention engages exactly like a human's.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true, isBotMention: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(decision).toBe('engage')
  })

  test('peer bot still engages on reply even in solo-human channel', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({
        authorId: 'peer1',
        authorName: 'peer1',
        authorIsBot: true,
        replyToBotMessageId: 'msg42',
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(decision).toBe('engage')
  })

  test('peer bot still engages on sticky credit even in solo-human channel', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'peer1', 10_000)
    const decision = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(decision).toBe('engage')
  })

  test('exits solo-human fallback only when a SECOND human appears (bots do not count)', () => {
    const ledger = new StickyLedger()
    const oneBotPlusOneHuman = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(oneBotPlusOneHuman).toBe('engage')

    const twoHumans = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), participant('bob'), { ...participant('peer1'), isBot: true }],
    })
    expect(twoHumans).toBe('observe')
  })

  test('observes lurker channels when fresh exact membership has two humans', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 10_000,
      participants: [
        participant('alice'),
        { ...participant('peer1'), isBot: true },
        { ...participant('peer2'), isBot: true },
      ],
      membership: { humans: 2, bots: 2, fetchedAt: 10_000, truncated: false },
    })

    expect(decision).toBe('observe')
  })

  test('preserves legacy solo fallback when membership is unavailable', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
      membership: null,
    })

    expect(decision).toBe('engage')
  })

  test('fresh exact membership wins when persisted speakers have left', () => {
    expect(resolveEffectiveHumans(3, { humans: 1, bots: 1, fetchedAt: 20_000, truncated: false }, 20_000)).toBe(1)
  })

  test('truncated and stale membership fall back to the max count', () => {
    expect(resolveEffectiveHumans(2, { humans: 1, bots: 1, fetchedAt: 0, truncated: true }, 10_000)).toBe(2)
    expect(resolveEffectiveHumans(2, { humans: 1, bots: 1, fetchedAt: 0, truncated: false }, 120_000)).toBe(2)
  })

  test('large truncated channels observe even with one persisted human', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
      membership: { humans: 30, bots: 5, fetchedAt: 0, truncated: true },
    })

    expect(decision).toBe('observe')
  })

  test('peer bots never qualify for fallback even with bot-only membership', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [{ ...participant('peer1'), isBot: true }],
      membership: { humans: 0, bots: 5, fetchedAt: 0, truncated: false },
    })

    expect(decision).toBe('observe')
  })

  test('sticky credit still bypasses high membership counts', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: [participant('alice')],
      membership: { humans: 50, bots: 5, fetchedAt: 1000, truncated: false },
    })

    expect(decision).toBe('engage')
  })
})

describe('decideEngagement (targets-others suppressors)', () => {
  test('observes a solo-human message that mentions someone other than us', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('observe')
  })

  test('observes a solo-human reply whose parent is someone else', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ replyToOtherMessageId: 'parent-from-bob' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('observe')
  })

  test('mention-of-us still engages even when the message also tags others', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isBotMention: true, mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('reply-to-us still engages even when other users are also tagged', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ replyToBotMessageId: 'msg42', mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('DM still engages even with mentions-of-others present', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isDm: true, workspace: '@dm', mentionsOthers: true }),
      config: baseConfig,
      key: 'discord-bot:@dm:d1:',
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
  })

  test('sticky credit still engages even with mentions-of-others present', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound({ mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
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
