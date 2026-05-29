import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { createEscListener } from './inspect'

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class FakeTty extends EventEmitter {
  isTTY = true as const
  rawMode = false
  resumed = false
  setRawMode(value: boolean): this {
    this.rawMode = value
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.resumed = false
    return this
  }
  feed(bytes: number[]): void {
    this.emit('data', Buffer.from(bytes))
  }
}

describe('createEscListener wiring', () => {
  test('returns null when the input is not a TTY', () => {
    const tty = new FakeTty()
    tty.isTTY = false as unknown as true
    expect(createEscListener(() => {}, tty as never)).toBeNull()
  })

  test('Ctrl-C byte invokes onSigint directly (no SIGINT round-trip)', () => {
    // given: an armed listener on a fake TTY
    const tty = new FakeTty()
    let sigints = 0
    const listener = createEscListener(() => {
      sigints += 1
    }, tty as never)!
    listener.armForStream()
    // when: the raw 0x03 byte arrives during the live tail
    tty.feed([0x03])
    // then: the exit callback fires straight away
    expect(sigints).toBe(1)
    listener.stop()
  })

  test('bare ESC aborts the per-stream signal without touching onSigint', async () => {
    // given: an armed listener that records sigint calls
    const tty = new FakeTty()
    let sigints = 0
    const listener = createEscListener(() => {
      sigints += 1
    }, tty as never)!
    const escSignal = listener.armForStream()
    // when: a bare ESC arrives and the debounce window elapses
    tty.feed([0x1b])
    await tick(80)
    // then: only the per-stream esc signal aborts; the exit path is untouched
    expect(escSignal.aborted).toBe(true)
    expect(sigints).toBe(0)
    listener.stop()
  })

  test('listener attaches its data handler before resuming the stream', () => {
    const tty = new FakeTty()
    const order: string[] = []
    tty.on('newListener', (event) => {
      if (event === 'data') order.push('listen')
    })
    const origResume = tty.resume.bind(tty)
    tty.resume = function patchedResume(this: FakeTty) {
      order.push('resume')
      return origResume()
    }
    const listener = createEscListener(() => {}, tty as never)!
    listener.armForStream()
    expect(order).toEqual(['listen', 'resume'])
    listener.stop()
  })
})
