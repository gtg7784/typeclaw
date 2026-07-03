import { describe, expect, test } from 'bun:test'

import { createDiscordThreadRoomResolver, discordThreadRoom } from './discord-bot-thread-room'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function fakeFetch(responses: Response[]): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    return responses.shift() ?? new Response(null, { status: 500 })
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('discordThreadRoom (pure)', () => {
  test('public/private/announcement thread types map to a thread room', () => {
    for (const type of [10, 11, 12]) {
      expect(discordThreadRoom({ type, parent_id: 'parent-c1' })).toEqual({ kind: 'thread', parentChat: 'parent-c1' })
    }
  })

  test('a thread without a parent_id still marks a thread room (fail-closed)', () => {
    expect(discordThreadRoom({ type: 11 })).toEqual({ kind: 'thread' })
  })

  test('a normal text channel is not a thread room', () => {
    expect(discordThreadRoom({ type: 0, parent_id: 'category-1' })).toBeUndefined()
  })

  test('an unknown lookup (fetch failed) fails closed to a bare thread room', () => {
    // Must NOT be treated as a confirmed non-thread channel — otherwise the
    // solo-human fallback could still engage an un-addressed fresh thread under
    // a transient Discord API failure (the original bug shape).
    expect(discordThreadRoom('unknown')).toEqual({ kind: 'thread' })
  })
})

describe('createDiscordThreadRoomResolver', () => {
  test('enriches a thread channel with room + parentChat', async () => {
    const { fn } = fakeFetch([jsonResponse({ type: 11, parent_id: 'parent-c1' })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    expect(await resolve('thread-t1')).toEqual({ kind: 'thread', parentChat: 'parent-c1' })
  })

  test('returns undefined for a normal channel', async () => {
    const { fn } = fakeFetch([jsonResponse({ type: 0 })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    expect(await resolve('chan-c1')).toBeUndefined()
  })

  test('caches per channel id so a busy thread issues a single fetch', async () => {
    const { fn, calls } = fakeFetch([jsonResponse({ type: 11, parent_id: 'parent-c1' })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    await resolve('thread-t1')
    await resolve('thread-t1')
    await resolve('thread-t1')
    expect(calls).toHaveLength(1)
  })

  test('a failed fetch fails closed to a bare thread room (no parentChat)', async () => {
    const { fn } = fakeFetch([new Response(null, { status: 500 })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    expect(await resolve('thread-t1')).toEqual({ kind: 'thread' })
  })

  test('a failed lookup is NOT cached so the next message retries', async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 500 }), jsonResponse({ type: 0 })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    expect(await resolve('chan-c1')).toEqual({ kind: 'thread' })
    expect(await resolve('chan-c1')).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  test('re-fetches after the ttl expires', async () => {
    let clock = 0
    const { fn, calls } = fakeFetch([
      jsonResponse({ type: 11, parent_id: 'p1' }),
      jsonResponse({ type: 11, parent_id: 'p1' }),
    ])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn, now: () => clock, ttlMs: 1000 })
    await resolve('thread-t1')
    clock = 1001
    await resolve('thread-t1')
    expect(calls).toHaveLength(2)
  })
})
