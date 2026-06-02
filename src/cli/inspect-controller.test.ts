import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { createEscController, createTailScope } from './inspect-controller'

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class FakeTty extends EventEmitter {
  isTTY = true
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

const fakeProc = {
  once: () => fakeProc,
  off: () => fakeProc,
}

describe('createEscController', () => {
  test('bare ESC after debounce window aborts the armed signal', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    expect(signal.aborted).toBe(false)
    await tick(30)
    expect(signal.aborted).toBe(true)
  })

  test('CSI follow-up byte within debounce window cancels the pending abort', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    ctrl.onChunk(Buffer.from([0x5b, 0x41]))
    await tick(30)
    expect(signal.aborted).toBe(false)
  })

  test('Ctrl-C surfaces sigint=true and never aborts the esc signal', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    const { sigint } = ctrl.onChunk(Buffer.from([0x03]))
    expect(sigint).toBe(true)
    await tick(30)
    expect(signal.aborted).toBe(false)
  })

  test('signal handed out by armForStream still aborts on ESC after clearPending → re-arm of listener (the picker pause/resume cycle)', async () => {
    // given: a stream is armed (caller stashes the signal as escSignal)
    const ctrl = createEscController({ debounceMs: 10 })
    const escSignal = ctrl.armForStream()
    // when: caller pauses the listener (picker opens) and later resumes it
    //       without re-arming — the original escSignal must remain bound to a
    //       live controller across this cycle, mirroring the inspect-loop flow
    //       where runInspect's chooseSession() pauses and re-enables raw mode
    //       in selectSession's finally block before streamSession is called.
    ctrl.clearPending()
    // and: after resume the user presses ESC during live tail
    ctrl.onChunk(Buffer.from([0x1b]))
    await tick(30)
    // then: the signal the live source is listening on must abort.
    //       In the regressing implementation, resume() recreated the
    //       AbortController, leaving escSignal detached. This test pins
    //       the bug at the controller layer with no TTY involvement.
    expect(escSignal.aborted).toBe(true)
  })

  test('armForStream after a previous arm: new signal aborts on ESC; old signal stays untouched', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const firstSignal = ctrl.armForStream()
    const secondSignal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    await tick(30)
    expect(secondSignal.aborted).toBe(true)
    expect(firstSignal.aborted).toBe(false)
  })

  test('pending timer from a previous arm does not abort a freshly armed signal', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    const freshSignal = ctrl.armForStream()
    await tick(30)
    expect(freshSignal.aborted).toBe(false)
  })

  test('dispose cancels any pending timer and detaches the controller', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    ctrl.dispose()
    await tick(30)
    expect(signal.aborted).toBe(false)
  })

  test('empty chunk is a no-op', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    const { sigint } = ctrl.onChunk(Buffer.alloc(0))
    expect(sigint).toBe(false)
    await tick(30)
    expect(signal.aborted).toBe(false)
  })
})

describe('createTailScope', () => {
  test('q quits the tail viewer', () => {
    const tty = new FakeTty()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: fakeProc as never })
    try {
      tty.feed([0x71])
      expect(scope.intent()).toBe('exit')
      expect(scope.signal.aborted).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  test('Ctrl-C still exits', () => {
    const tty = new FakeTty()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: fakeProc as never })
    try {
      tty.feed([0x03])
      expect(scope.intent()).toBe('exit')
      expect(scope.signal.aborted).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  test('bare ESC returns back, not exit', async () => {
    const tty = new FakeTty()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: fakeProc as never })
    try {
      tty.feed([0x1b])
      await tick(80)
      expect(scope.intent()).toBe('back')
      expect(scope.signal.aborted).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  test('q on a non-TTY input is a no-op', () => {
    const tty = new FakeTty()
    tty.isTTY = false
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: fakeProc as never })
    try {
      tty.feed([0x71])
      expect(scope.intent()).toBeNull()
      expect(scope.signal.aborted).toBe(false)
    } finally {
      scope.dispose()
    }
  })
})
