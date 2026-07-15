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

  test('a normal channel with parent_id:null is not a thread room', () => {
    expect(discordThreadRoom({ type: 0, parent_id: null })).toBeUndefined()
  })

  test('a thread with parent_id:null stays a bare retryable thread room', () => {
    expect(discordThreadRoom({ type: 11, parent_id: null })).toEqual({ kind: 'thread' })
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
    const { fn } = fakeFetch([jsonResponse({ type: 11, parent_id: '201' })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    expect(await resolve('101')).toEqual({ kind: 'thread', parentChat: '201' })
  })

  test('returns undefined for a normal channel', async () => {
    const { fn } = fakeFetch([jsonResponse({ type: 0 })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    expect(await resolve('101')).toBeUndefined()
  })

  test('accepts parent_id:null on a normal channel and caches it', async () => {
    const { fn, calls } = fakeFetch([jsonResponse({ type: 0, parent_id: null })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })

    expect(await resolve.resolveStatus('101')).toEqual({ room: undefined, parentChecked: true })
    expect(await resolve.resolveStatus('101')).toEqual({ room: undefined, parentChecked: true })
    expect(calls).toHaveLength(1)
  })

  test('keeps a thread with parent_id:null retryable', async () => {
    const { fn, calls } = fakeFetch([
      jsonResponse({ type: 11, parent_id: null }),
      jsonResponse({ type: 11, parent_id: null }),
    ])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })

    expect(await resolve.resolveStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolve.resolveStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(calls).toHaveLength(2)
  })

  test('caches per channel id so a busy thread issues a single fetch', async () => {
    const { fn, calls } = fakeFetch([jsonResponse({ type: 11, parent_id: '201' })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    await resolve('101')
    await resolve('101')
    await resolve('101')
    expect(calls).toHaveLength(1)
  })

  test('a failed fetch fails closed to a bare thread room (no parentChat)', async () => {
    const { fn } = fakeFetch([new Response(null, { status: 500 })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    expect(await resolve('101')).toEqual({ kind: 'thread' })
  })

  test('a failed lookup is NOT cached so the next message retries', async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 500 }), jsonResponse({ type: 0 })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })
    expect(await resolve('101')).toEqual({ kind: 'thread' })
    expect(await resolve('101')).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  test('re-fetches after the ttl expires', async () => {
    let clock = 0
    const { fn, calls } = fakeFetch([
      jsonResponse({ type: 11, parent_id: '201' }),
      jsonResponse({ type: 11, parent_id: '201' }),
    ])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn, now: () => clock, ttlMs: 1000 })
    await resolve('101')
    clock = 1001
    await resolve('101')
    expect(calls).toHaveLength(2)
  })

  test('rejects malformed IDs before building a Discord API path', async () => {
    const { fn, calls } = fakeFetch([jsonResponse({ type: 0 })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })

    for (const id of ['room/../1', '0', '01', '18446744073709551616']) {
      expect(await resolve(id)).toEqual({ kind: 'thread' })
      expect(await resolve.resolveStatus(id)).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    }
    expect(calls).toHaveLength(0)
  })

  test('treats successful metadata with absent or non-numeric type as transient and retries', async () => {
    const { fn, calls } = fakeFetch([
      jsonResponse({ id: '101', name: 'missing-type' }),
      jsonResponse({ id: '101', name: 'wrong-type', type: '0' }),
      jsonResponse({ id: '101', name: 'general', type: 0 }),
    ])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })

    expect(await resolve.resolveStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolve.resolveStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolve.resolveStatus('101')).toEqual({ room: undefined, parentChecked: true })
    expect(calls).toHaveLength(3)
  })

  test('keeps a confirmed thread with a missing parent retryable', async () => {
    const { fn, calls } = fakeFetch([jsonResponse({ type: 11 }), jsonResponse({ type: 11, parent_id: '201' })])
    const resolve = createDiscordThreadRoomResolver({ token: 'tok', fetchImpl: fn })

    expect(await resolve.resolveStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolve.resolveStatus('101')).toEqual({
      room: { kind: 'thread', parentChat: '201' },
      parentChecked: true,
    })
    expect(calls).toHaveLength(2)
  })
})
