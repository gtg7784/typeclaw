import { describe, expect, test } from 'bun:test'

import { formatClaimMatchRule, type PartialChannelOrigin } from './match-rule'
import { createPendingClaimRegistry } from './pending'

const aliceOnSlack: PartialChannelOrigin = {
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'D0ALICE',
  isDm: true,
  authorId: 'U_ALICE',
}

const bobOnDiscord: PartialChannelOrigin = {
  adapter: 'discord-bot',
  workspace: '9999',
  chat: '8888',
  isDm: true,
  authorId: 'U_BOB',
}

describe('PendingClaimRegistry', () => {
  test('no pending → tryConsume returns no-pending', () => {
    const reg = createPendingClaimRegistry()
    expect(reg.tryConsume('claim-AAAA-BBBB', aliceOnSlack, formatClaimMatchRule)).toEqual({ kind: 'no-pending' })
  })

  test('consume matching code → returns consumed and clears registry', () => {
    let nowMs = 1_000_000
    const reg = createPendingClaimRegistry({ now: () => nowMs })
    reg.start({
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      ttlMs: 600_000,
      startedAt: nowMs,
      expiresAt: nowMs + 600_000,
    })
    expect(reg.size()).toBe(1)
    const result = reg.tryConsume('claim-AAAA-BBBB', aliceOnSlack, formatClaimMatchRule)
    expect(result).toEqual({
      kind: 'consumed',
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      matchRule: 'slack:* author:U_ALICE',
      origin: aliceOnSlack,
    })
    expect(reg.size()).toBe(0)
    expect(reg.tryConsume('claim-AAAA-BBBB', aliceOnSlack, formatClaimMatchRule)).toEqual({ kind: 'no-pending' })
  })

  test('wrong code returns no-match without clearing the pending claim', () => {
    let nowMs = 1_000_000
    const reg = createPendingClaimRegistry({ now: () => nowMs })
    reg.start({
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      ttlMs: 600_000,
      startedAt: nowMs,
      expiresAt: nowMs + 600_000,
    })
    const result = reg.tryConsume('claim-WRONG-CODE', aliceOnSlack, formatClaimMatchRule)
    expect(result).toEqual({ kind: 'no-match' })
    expect(reg.size()).toBe(1)
  })

  test('channel-scoped pending rejects inbound from other adapter', () => {
    let nowMs = 1_000_000
    const reg = createPendingClaimRegistry({ now: () => nowMs })
    reg.start({
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      channel: 'slack-bot',
      ttlMs: 600_000,
      startedAt: nowMs,
      expiresAt: nowMs + 600_000,
    })
    const result = reg.tryConsume('claim-AAAA-BBBB', bobOnDiscord, formatClaimMatchRule)
    expect(result).toEqual({ kind: 'wrong-channel' })
    expect(reg.size()).toBe(1)
  })

  test('TTL expiry: consume after expiresAt returns expired and clears', () => {
    let nowMs = 1_000_000
    const reg = createPendingClaimRegistry({ now: () => nowMs })
    reg.start({
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      ttlMs: 100,
      startedAt: nowMs,
      expiresAt: nowMs + 100,
    })
    nowMs += 200
    const result = reg.tryConsume('claim-AAAA-BBBB', aliceOnSlack, formatClaimMatchRule)
    expect(result).toEqual({ kind: 'expired' })
    expect(reg.size()).toBe(0)
  })

  test('cancel matching code returns true and clears', () => {
    const nowMs = 1_000_000
    const reg = createPendingClaimRegistry({ now: () => nowMs })
    reg.start({
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      ttlMs: 600_000,
      startedAt: nowMs,
      expiresAt: nowMs + 600_000,
    })
    expect(reg.cancel('claim-AAAA-BBBB')).toBe(true)
    expect(reg.size()).toBe(0)
  })

  test('cancel non-matching code returns false and preserves pending', () => {
    const nowMs = 1_000_000
    const reg = createPendingClaimRegistry({ now: () => nowMs })
    reg.start({
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      ttlMs: 600_000,
      startedAt: nowMs,
      expiresAt: nowMs + 600_000,
    })
    expect(reg.cancel('claim-OTHER-CODE')).toBe(false)
    expect(reg.size()).toBe(1)
  })

  test('second start replaces the prior pending', () => {
    const nowMs = 1_000_000
    const reg = createPendingClaimRegistry({ now: () => nowMs })
    reg.start({
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      ttlMs: 600_000,
      startedAt: nowMs,
      expiresAt: nowMs + 600_000,
    })
    reg.start({
      code: 'claim-CCCC-DDDD',
      role: 'member',
      ttlMs: 600_000,
      startedAt: nowMs,
      expiresAt: nowMs + 600_000,
    })
    expect(reg.current()?.code).toBe('claim-CCCC-DDDD')
    expect(reg.current()?.role).toBe('member')
  })
})

describe('formatClaimMatchRule', () => {
  test('slack: platform-wide wildcard + author', () => {
    expect(formatClaimMatchRule(aliceOnSlack)).toBe('slack:* author:U_ALICE')
  })

  test('discord: platform-wide wildcard + author', () => {
    expect(formatClaimMatchRule(bobOnDiscord)).toBe('discord:* author:U_BOB')
  })

  test('kakao: platform-wide wildcard + author (works for DM, group, and open chats alike)', () => {
    expect(
      formatClaimMatchRule({
        adapter: 'kakaotalk',
        workspace: '',
        chat: '42',
        isDm: false,
        authorId: 'kakao_user_x',
      }),
    ).toBe('kakao:* author:kakao_user_x')
  })

  test('telegram: platform-wide wildcard + author', () => {
    expect(
      formatClaimMatchRule({
        adapter: 'telegram-bot',
        workspace: '42',
        chat: '42',
        isDm: true,
        authorId: 'tg_user',
      }),
    ).toBe('telegram:* author:tg_user')
  })

  test('claim from a non-DM context produces the same platform-wide rule', () => {
    expect(
      formatClaimMatchRule({
        adapter: 'slack-bot',
        workspace: 'T0123',
        chat: 'C0GENERAL',
        isDm: false,
        authorId: 'U_ALICE',
      }),
    ).toBe('slack:* author:U_ALICE')
  })
})
