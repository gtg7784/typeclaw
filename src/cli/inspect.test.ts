import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { createTailScope } from './inspect-controller'

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

class FakeProc extends EventEmitter {
  fire(signal: string): void {
    this.emit(signal)
  }
}

describe('createTailScope wiring', () => {
  test('arms raw mode and attaches a data handler on a TTY', () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    expect(tty.rawMode).toBe(true)
    expect(tty.resumed).toBe(true)
    expect(tty.listenerCount('data')).toBe(1)
    scope.dispose()
  })

  test('Ctrl-C byte aborts with exit intent', () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    tty.feed([0x03])
    expect(scope.signal.aborted).toBe(true)
    expect(scope.intent()).toBe('exit')
    scope.dispose()
  })

  test('bare ESC aborts with back intent after the debounce window', async () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: proc as never })
    tty.feed([0x1b])
    expect(scope.signal.aborted).toBe(false)
    await tick(30)
    expect(scope.signal.aborted).toBe(true)
    expect(scope.intent()).toBe('back')
    scope.dispose()
  })

  test('arrow-key CSI sequence does not abort', async () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: proc as never })
    tty.feed([0x1b])
    tty.feed([0x5b, 0x41])
    await tick(30)
    expect(scope.signal.aborted).toBe(false)
    expect(scope.intent()).toBeNull()
    scope.dispose()
  })

  test('SIGINT aborts with exit intent', () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    proc.fire('SIGINT')
    expect(scope.signal.aborted).toBe(true)
    expect(scope.intent()).toBe('exit')
    scope.dispose()
  })

  test('dispose restores raw mode and detaches handlers without pausing stdin', () => {
    // The next clack picker must inherit a non-raw, still-flowing stdin: a paused
    // process.stdin does not reliably re-flow under Bun, which is what froze the
    // picker. Detaching our data handler and clearing raw mode lets clack own it.
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    expect(tty.listenerCount('data')).toBe(1)
    scope.dispose()
    expect(tty.rawMode).toBe(false)
    expect(tty.listenerCount('data')).toBe(0)
    expect(tty.pauseCalls).toBe(0)
    expect(proc.listenerCount('SIGINT')).toBe(0)
    expect(proc.listenerCount('SIGTERM')).toBe(0)
  })

  test('dispose is idempotent', () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    scope.dispose()
    scope.dispose()
    expect(tty.listenerCount('data')).toBe(0)
  })

  test('non-TTY input never touches raw mode but still aborts on signals', () => {
    const tty = new FakeTty()
    tty.isTTY = false as unknown as true
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    expect(tty.listenerCount('data')).toBe(0)
    proc.fire('SIGTERM')
    expect(scope.signal.aborted).toBe(true)
    expect(scope.intent()).toBe('exit')
    scope.dispose()
  })
})
