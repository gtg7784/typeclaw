import { describe, expect, test } from 'bun:test'

import { createWebexPrefetchLimiter, isWebexRateLimitError } from './webex-prefetch-limiter'

const ROOM = 'room-1'
const OTHER = 'room-2'

describe('createWebexPrefetchLimiter', () => {
  test('serializes same-room work at concurrency 1', async () => {
    const limiter = createWebexPrefetchLimiter({ concurrency: 1 })
    let active = 0
    let maxActive = 0
    const job = () =>
      limiter.run(ROOM, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return 'done'
      })

    await Promise.all([job(), job(), job()])

    expect(maxActive).toBe(1)
  })

  test('runs up to `concurrency` same-room jobs at once', async () => {
    const limiter = createWebexPrefetchLimiter({ concurrency: 2, admitTimeoutMs: 1000 })
    let active = 0
    let maxActive = 0
    const job = () =>
      limiter.run(ROOM, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
      })

    await Promise.all([job(), job(), job(), job()])

    expect(maxActive).toBe(2)
  })

  test('different rooms never contend — each gets its own permit pool', async () => {
    // given: concurrency 1 per room, but two DIFFERENT rooms each holding a slot
    const limiter = createWebexPrefetchLimiter({ concurrency: 1, admitTimeoutMs: 15 })
    let concurrent = 0
    let maxConcurrent = 0
    const job = (room: string) =>
      limiter.run(room, async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 20))
        concurrent--
        return room
      })

    // then: both run in parallel despite concurrency 1, because keys differ
    const [a, b] = await Promise.all([job(ROOM), job(OTHER)])

    expect(maxConcurrent).toBe(2)
    expect([a, b]).toEqual([
      { admitted: true, value: ROOM },
      { admitted: true, value: OTHER },
    ])
  })

  test('skips (admitted=false) without running work when no same-room slot frees in time', async () => {
    const limiter = createWebexPrefetchLimiter({ concurrency: 1, admitTimeoutMs: 15 })
    const block = Promise.withResolvers<void>()
    let secondRan = false

    const held = limiter.run(ROOM, async () => {
      await block.promise
    })
    const skipped = await limiter.run(ROOM, async () => {
      secondRan = true
    })

    expect(skipped).toEqual({ admitted: false })
    expect(secondRan).toBe(false)
    block.resolve()
    await held
  })

  test('admits a queued same-room waiter once a slot frees within the budget', async () => {
    const limiter = createWebexPrefetchLimiter({ concurrency: 1, admitTimeoutMs: 1000 })
    const block = Promise.withResolvers<void>()

    const held = limiter.run(ROOM, async () => {
      await block.promise
      return 'first'
    })
    const queued = limiter.run(ROOM, async () => 'second')

    block.resolve()
    await held

    await expect(queued).resolves.toEqual({ admitted: true, value: 'second' })
  })

  test('a timed-out grant releases its slot instead of leaking it', async () => {
    // given: one slot held long enough that the queued waiter times out, but the
    // holder releases AFTER that timeout — exercising the late-grant release path.
    const limiter = createWebexPrefetchLimiter({ concurrency: 1, admitTimeoutMs: 15 })
    const block = Promise.withResolvers<void>()

    const held = limiter.run(ROOM, async () => {
      await block.promise
    })
    const skipped = await limiter.run(ROOM, async () => 'never')
    expect(skipped).toEqual({ admitted: false })

    block.resolve()
    await held

    // then: the slot is free again — a fresh job admits and runs.
    await expect(limiter.run(ROOM, async () => 'ok')).resolves.toEqual({ admitted: true, value: 'ok' })
  })

  test('releases the slot even when work throws', async () => {
    const limiter = createWebexPrefetchLimiter({ concurrency: 1, admitTimeoutMs: 1000 })

    await expect(limiter.run(ROOM, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(limiter.run(ROOM, async () => 'ok')).resolves.toEqual({ admitted: true, value: 'ok' })
  })
})

describe('isWebexRateLimitError', () => {
  test('matches the SDK rate-limit codes', () => {
    expect(isWebexRateLimitError(Object.assign(new Error('Rate limited'), { code: 'rate_limited' }))).toBe(true)
    expect(isWebexRateLimitError(Object.assign(new Error('HTTP 429'), { code: 'http_429' }))).toBe(true)
  })

  test('does not match other failures', () => {
    expect(isWebexRateLimitError(Object.assign(new Error('boom'), { code: 'http_500' }))).toBe(false)
    expect(isWebexRateLimitError(new Error('network down'))).toBe(false)
    expect(isWebexRateLimitError(null)).toBe(false)
    expect(isWebexRateLimitError('429')).toBe(false)
  })
})
