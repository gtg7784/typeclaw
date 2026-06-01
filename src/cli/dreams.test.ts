import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { waitForViewerKey } from './dreams'

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class FakeTty extends EventEmitter {
  isTTY = true as const
  rawMode = false
  resumed = false
  pauseCalls = 0
  setRawMode(value: boolean): this {
    this.rawMode = value
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.pauseCalls += 1
    this.resumed = false
    return this
  }
  feed(bytes: number[]): void {
    this.emit('data', Buffer.from(bytes))
  }
}

describe('waitForViewerKey', () => {
  test('exits when input is not a TTY', async () => {
    const tty = new FakeTty()
    tty.isTTY = false as unknown as true
    expect(await waitForViewerKey(false, tty as never)).toBe('exit')
  })

  test('standalone Esc returns to the list', async () => {
    const tty = new FakeTty()
    const pending = waitForViewerKey(false, tty as never)
    tty.feed([0x1b])
    expect(await pending).toBe('back')
  })

  test('arrow-key CSI sequence does not trigger back', async () => {
    // given: an open detail view
    const tty = new FakeTty()
    let settled: string | null = null
    const pending = waitForViewerKey(false, tty as never).then((a) => {
      settled = a
      return a
    })
    // when: the user presses ↑ (Esc + "[A") within the debounce window
    tty.feed([0x1b])
    tty.feed([0x5b, 0x41])
    await tick(80)
    // then: the view stays open — arrow keys must not exit it
    expect(settled).toBeNull()
    // and: a real Esc still works afterwards
    tty.feed([0x1b])
    expect(await pending).toBe('back')
  })

  test('q quits the browser', async () => {
    const tty = new FakeTty()
    const pending = waitForViewerKey(false, tty as never)
    tty.feed([0x71])
    expect(await pending).toBe('exit')
  })

  test('Ctrl-C quits the browser', async () => {
    const tty = new FakeTty()
    const pending = waitForViewerKey(false, tty as never)
    tty.feed([0x03])
    expect(await pending).toBe('exit')
  })

  test('teardown restores raw mode without pausing stdin, so the next picker stays usable', async () => {
    const tty = new FakeTty()
    const pending = waitForViewerKey(false, tty as never)
    tty.feed([0x1b])
    await pending
    expect(tty.rawMode).toBe(false)
    expect(tty.pauseCalls).toBe(0)
    expect(tty.listenerCount('data')).toBe(0)
  })
})
