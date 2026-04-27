import { describe, expect, test } from 'bun:test'

import { createIdleDetector } from './idle-detector'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('createIdleDetector', () => {
  test('fires onIdle after idleMs when armed', async () => {
    let fired = 0
    const detector = createIdleDetector({ idleMs: 20, onIdle: () => fired++ })
    detector.arm()

    await sleep(40)

    expect(fired).toBe(1)
    detector.dispose()
  })

  test('cancel before idleMs prevents firing', async () => {
    let fired = 0
    const detector = createIdleDetector({ idleMs: 20, onIdle: () => fired++ })
    detector.arm()
    detector.cancel()

    await sleep(40)

    expect(fired).toBe(0)
    detector.dispose()
  })

  test('rearming resets the timer (only one fire from the latest arm)', async () => {
    let fired = 0
    const detector = createIdleDetector({ idleMs: 30, onIdle: () => fired++ })
    detector.arm()
    await sleep(15)
    detector.arm()
    await sleep(15)

    expect(fired).toBe(0)

    await sleep(25)

    expect(fired).toBe(1)
    detector.dispose()
  })

  test('dispose stops further firings even when armed', async () => {
    let fired = 0
    const detector = createIdleDetector({ idleMs: 20, onIdle: () => fired++ })
    detector.arm()
    detector.dispose()

    await sleep(40)

    expect(fired).toBe(0)
  })

  test('arm after dispose is a no-op', async () => {
    let fired = 0
    const detector = createIdleDetector({ idleMs: 20, onIdle: () => fired++ })
    detector.dispose()
    detector.arm()

    await sleep(40)

    expect(fired).toBe(0)
  })

  test('cancel without prior arm is harmless', () => {
    const detector = createIdleDetector({ idleMs: 20, onIdle: () => {} })
    expect(() => detector.cancel()).not.toThrow()
    detector.dispose()
  })

  test('multiple disposes are harmless', () => {
    const detector = createIdleDetector({ idleMs: 20, onIdle: () => {} })
    detector.dispose()
    expect(() => detector.dispose()).not.toThrow()
  })
})
