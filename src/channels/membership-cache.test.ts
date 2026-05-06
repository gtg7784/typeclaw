import { describe, expect, test } from 'bun:test'

import { MEMBERSHIP_CACHE_TRANSIENT_TTL_MS, MEMBERSHIP_CACHE_TTL_MS, type MembershipResolver } from './membership'
import { createMembershipCache } from './membership-cache'
import type { ChannelKey } from './types'

const key: ChannelKey = { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null }

describe('createMembershipCache', () => {
  test('returns cached membership within the positive TTL', async () => {
    let now = 1000
    let calls = 0
    const cache = createMembershipCache({
      now: () => now,
      resolver: async () => {
        calls++
        return { humans: 2, bots: 1, fetchedAt: now, truncated: false }
      },
    })

    expect(await cache.warmUp(key)).toEqual({ humans: 2, bots: 1, fetchedAt: 1000, truncated: false })
    now += MEMBERSHIP_CACHE_TTL_MS - 1

    expect(cache.get(key)).toEqual({ humans: 2, bots: 1, fetchedAt: 1000, truncated: false })
    expect(calls).toBe(1)
  })

  test('expires positive entries after one stale read', async () => {
    let now = 1000
    let calls = 0
    const cache = createMembershipCache({
      now: () => now,
      resolver: async () => {
        calls++
        return { humans: calls, bots: 0, fetchedAt: now, truncated: false }
      },
    })
    await cache.warmUp(key)
    now += MEMBERSHIP_CACHE_TTL_MS + 1

    expect(cache.read(key)).toEqual({
      kind: 'stale',
      membership: { humans: 1, bots: 0, fetchedAt: 1000, truncated: false },
    })
    expect(await cache.warmUp(key)).toEqual({ humans: 2, bots: 0, fetchedAt: now, truncated: false })
    expect(calls).toBe(2)
  })

  test('deduplicates concurrent resolver calls', async () => {
    let calls = 0
    let release!: () => void
    const unblock = new Promise<void>((resolve) => {
      release = resolve
    })
    const resolver: MembershipResolver = async () => {
      calls++
      await unblock
      return { humans: 3, bots: 1, fetchedAt: 10, truncated: false }
    }
    const cache = createMembershipCache({ now: () => 10, resolver })

    const first = cache.warmUp(key)
    const second = cache.warmUp(key)
    release()

    expect(await Promise.all([first, second])).toEqual([
      { humans: 3, bots: 1, fetchedAt: 10, truncated: false },
      { humans: 3, bots: 1, fetchedAt: 10, truncated: false },
    ])
    expect(calls).toBe(1)
  })

  test('negative cache uses the transient TTL', async () => {
    let now = 1000
    let calls = 0
    const cache = createMembershipCache({
      now: () => now,
      resolver: async () => {
        calls++
        return calls === 1 ? { kind: 'transient' } : { humans: 4, bots: 1, fetchedAt: now, truncated: false }
      },
    })

    expect(await cache.warmUp(key)).toBeNull()
    now += MEMBERSHIP_CACHE_TRANSIENT_TTL_MS - 1
    expect(await cache.warmUp(key)).toBeNull()
    now += 2
    expect(await cache.warmUp(key)).toEqual({ humans: 4, bots: 1, fetchedAt: now, truncated: false })
    expect(calls).toBe(2)
  })

  test('manual invalidation clears an entry', async () => {
    let calls = 0
    const cache = createMembershipCache({
      now: () => 0,
      resolver: async () => {
        calls++
        return { humans: calls, bots: 0, fetchedAt: 0, truncated: false }
      },
    })

    await cache.warmUp(key)
    cache.invalidate(key)

    expect(cache.get(key)).toBeNull()
    expect(await cache.warmUp(key)).toEqual({ humans: 2, bots: 0, fetchedAt: 0, truncated: false })
  })
})
