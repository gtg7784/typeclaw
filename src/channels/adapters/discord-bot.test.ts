import { describe, expect, test } from 'bun:test'

import { isAllowed } from '@/channels/schema'

describe('discord-bot adapter (unit-level pure helpers)', () => {
  test('isAllowed denies a guild channel not in the allow list', () => {
    expect(isAllowed(['guild:1/2'], '1', '99')).toBe(false)
    expect(isAllowed(['guild:1/2'], '2', '2')).toBe(false)
  })

  test('isAllowed admits a guild channel in the allow list', () => {
    expect(isAllowed(['guild:1/2'], '1', '2')).toBe(true)
  })

  test('isAllowed admits DMs only when the rule covers @dm', () => {
    expect(isAllowed(['guild:*'], '@dm', 'd1')).toBe(false)
    expect(isAllowed(['dm:*'], '@dm', 'd1')).toBe(true)
    expect(isAllowed(['*'], '@dm', 'd1')).toBe(true)
  })
})
