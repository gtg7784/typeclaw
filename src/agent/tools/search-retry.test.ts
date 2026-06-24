import { describe, expect, test } from 'bun:test'

import { backoffDelayMs, SearchRetryAbortedError, withSearchRetry } from './search-retry'

const noSleep = async () => {}

describe('withSearchRetry', () => {
  test('returns immediately on first success without retrying', async () => {
    // given
    let calls = 0
    const work = async () => {
      calls++
      return 'ok'
    }

    // when
    const result = await withSearchRetry(work, { shouldRetry: () => true, sleep: noSleep })

    // then
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  test('retries a retryable error then succeeds', async () => {
    // given
    let calls = 0
    const work = async () => {
      calls++
      if (calls < 3) throw new Error('captcha')
      return 'ok'
    }

    // when
    const result = await withSearchRetry(work, { attempts: 3, shouldRetry: () => true, sleep: noSleep })

    // then
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  test('stops immediately on a non-retryable error', async () => {
    // given
    let calls = 0
    const work = async () => {
      calls++
      throw new Error('parse failure')
    }

    // when / then
    await expect(withSearchRetry(work, { attempts: 5, shouldRetry: () => false, sleep: noSleep })).rejects.toThrow(
      'parse failure',
    )
    expect(calls).toBe(1)
  })

  test('throws the last error after exhausting all attempts', async () => {
    // given
    let calls = 0
    const work = async () => {
      calls++
      throw new Error(`attempt ${calls}`)
    }

    // when / then
    await expect(withSearchRetry(work, { attempts: 3, shouldRetry: () => true, sleep: noSleep })).rejects.toThrow(
      'attempt 3',
    )
    expect(calls).toBe(3)
  })

  test('aborts before running when the signal is already aborted', async () => {
    // given
    let calls = 0
    const controller = new AbortController()
    controller.abort()

    // when / then
    await expect(
      withSearchRetry(
        async () => {
          calls++
          return 'ok'
        },
        { shouldRetry: () => true, sleep: noSleep, signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(SearchRetryAbortedError)
    expect(calls).toBe(0)
  })
})

describe('backoffDelayMs', () => {
  test('grows the cap exponentially but never exceeds maxDelayMs', () => {
    // given full jitter returns a value within [0, capped]
    const base = 2_000
    const max = 15_000

    // when / then
    for (let attempt = 0; attempt < 6; attempt++) {
      const capped = Math.min(max, base * 2 ** attempt)
      const delay = backoffDelayMs(attempt, base, max)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(capped)
      expect(delay).toBeLessThanOrEqual(max)
    }
  })
})
