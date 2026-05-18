import { describe, expect, test } from 'bun:test'

import { expectStable, waitFor } from './wait-for'

describe('waitFor', () => {
  test('resolves immediately when predicate is already truthy (fast path, no timer tick)', async () => {
    const start = Date.now()
    const result = await waitFor(() => 'ready')
    expect(result).toBe('ready')
    expect(Date.now() - start).toBeLessThan(5)
  })

  test('resolves with the truthy value when predicate flips during polling', async () => {
    let flipped = false
    setTimeout(() => {
      flipped = true
    }, 15)

    const result = await waitFor(() => (flipped ? 'flipped' : false))
    expect(result).toBe('flipped')
  })

  test('rejects with a descriptive error when predicate stays falsy past timeoutMs', async () => {
    await expect(waitFor(() => false, { timeoutMs: 30, description: 'thing-to-happen' })).rejects.toThrow(
      /thing-to-happen did not become truthy within 30ms/,
    )
  })

  test('supports async predicates', async () => {
    let counter = 0
    const result = await waitFor(async () => {
      counter++
      return counter >= 3 ? counter : null
    })
    expect(result).toBe(3)
  })

  test('respects the custom intervalMs', async () => {
    let calls = 0
    await expect(
      waitFor(
        () => {
          calls++
          return false
        },
        { timeoutMs: 50, intervalMs: 20 },
      ),
    ).rejects.toThrow()
    // initial call + ~2-3 polls at 20ms intervals over 50ms
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(calls).toBeLessThanOrEqual(5)
  })
})

describe('expectStable', () => {
  test('resolves when predicate stays falsy for the full durationMs', async () => {
    const start = Date.now()
    await expectStable(() => false, { durationMs: 25 })
    expect(Date.now() - start).toBeGreaterThanOrEqual(20)
  })

  test('rejects when predicate becomes truthy mid-duration', async () => {
    let flipped = false
    setTimeout(() => {
      flipped = true
    }, 10)

    await expect(expectStable(() => flipped, { durationMs: 50, description: 'no-event' })).rejects.toThrow(
      /no-event became truthy before 50ms elapsed/,
    )
  })
})
