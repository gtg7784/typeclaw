import { describe, expect, test } from 'bun:test'

import { expectStable, waitFor } from './wait-for'

describe('waitFor', () => {
  test('resolves immediately when predicate is already truthy (fast path, no timer tick)', async () => {
    // Assert the fast-path BEHAVIOR (return on the first predicate call, no
    // polling loop) instead of a wall-clock bound. History: the timing
    // assertion was 5ms (74be577-era), widened to 50ms (86abb5f) after CI
    // flakes, then STILL flaked at 108ms under 18-worker `bun test --parallel`
    // contention — a saturated scheduler stretches even one `await` microtask
    // past any fixed budget. Counting invocations is scheduler-independent:
    // the loop pays one `setTimeout` per extra call, so "called once" IS
    // "no timer tick".
    let calls = 0
    const result = await waitFor(() => {
      calls++
      return 'ready'
    })
    expect(result).toBe('ready')
    expect(calls).toBe(1)
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
    // Drive the flip from the polling loop itself rather than a wall-clock
    // setTimeout, AND flip on call #2 with a wide durationMs budget.
    //
    // History: a previous deflake (74be577) used a call-counter that flipped
    // on call #3 with durationMs=50ms / intervalMs=5ms. That still leaves a
    // race: `expectStable` checks `Date.now() < deadline` BETWEEN iterations,
    // so if any of the two intervening sleeps gets delayed past the 50ms
    // deadline (run #26550782470: failing test took 74ms, sleeps stretched
    // under 18-worker `bun test --parallel` contention), the loop exits
    // before call #3 lands and the expected rejection becomes a silent
    // resolve.
    //
    // Flipping on call #2 with durationMs=5000 collapses the race window:
    // only ONE sleep separates the first falsy call from the truthy one,
    // and even a 100x scheduler hiccup (500ms sleep) fits well inside the
    // budget. The test still exercises the same behavior — predicate
    // becomes truthy mid-duration, rejection fires — without any wall-clock
    // dependency in the assertion path.
    let calls = 0
    const predicate = () => {
      calls++
      return calls >= 2
    }

    await expect(expectStable(predicate, { durationMs: 5000, description: 'no-event' })).rejects.toThrow(
      /no-event became truthy before 5000ms elapsed/,
    )
  })
})
