import { describe, expect, test } from 'bun:test'

import { waitForAbort } from './index'

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('waitForAbort', () => {
  test('resolves immediately for an already-aborted signal', async () => {
    const c = new AbortController()
    c.abort()

    let waitWon = false
    await Promise.race([
      waitForAbort(c.signal).then(() => {
        waitWon = true
      }),
      tick(50),
    ])

    expect(waitWon).toBe(true)
  })

  test('resolves only after abort() is called', async () => {
    const c = new AbortController()
    let resolved = false
    const p = waitForAbort(c.signal).then(() => {
      resolved = true
    })

    await tick(20)
    expect(resolved).toBe(false)

    c.abort()
    await p
    expect(resolved).toBe(true)
  })
})
