import { describe, expect, test } from 'bun:test'

import { isAllowed } from '@/channels/schema'

import { createTypingCallback } from './slack-bot'

describe('slack-bot adapter (unit-level pure helpers)', () => {
  test('isAllowed admits a team channel via team:T/C', () => {
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0ACME', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0ACME', 'C0OTHER')).toBe(false)
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0WIDGET', 'C0DEPLOY')).toBe(false)
  })

  test('isAllowed admits all team channels via team:*', () => {
    expect(isAllowed(['team:*'], 'T0ACME', 'C0CHANNEL')).toBe(true)
    expect(isAllowed(['team:*'], '@dm', 'D0DMID')).toBe(false)
  })

  test('isAllowed admits Slack DMs only when the rule covers @dm', () => {
    expect(isAllowed(['team:*'], '@dm', 'D0DMID')).toBe(false)
    expect(isAllowed(['im:*'], '@dm', 'D0DMID')).toBe(true)
    expect(isAllowed(['*'], '@dm', 'D0DMID')).toBe(true)
  })

  test('isAllowed admits a Slack channel by id via channel:C', () => {
    expect(isAllowed(['channel:C0DEPLOY'], 'T0ACME', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['channel:C0DEPLOY'], 'T0WIDGET', 'C0DEPLOY')).toBe(true)
  })
})

describe('slack-bot createTypingCallback', () => {
  test('is a no-op for matching slack-bot targets (Slack has no public typing endpoint)', async () => {
    const infos: string[] = []
    const cb = createTypingCallback({
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null })
    expect(infos.some((m) => m.includes('typing (no-op)'))).toBe(true)
  })

  test('skips disallowed channels silently', async () => {
    const infos: string[] = []
    const cb = createTypingCallback({
      configRef: () => ({
        allow: ['team:T0OTHER'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null })
    expect(infos).toHaveLength(0)
  })

  test('rejects non-slack adapter without logging', async () => {
    const infos: string[] = []
    const cb = createTypingCallback({
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: '1', chat: '2', thread: null })
    expect(infos).toHaveLength(0)
  })
})
