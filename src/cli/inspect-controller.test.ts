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

// The bare-ESC idle window is max(debounceMs, 500). Tests pass a small
// debounceMs but must wait past the 500ms floor to observe a bare-ESC abort.
const IDLE_WAIT_MS = 600

describe('createEscController', () => {
  test('bare ESC aborts the armed signal after the idle window', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    expect(signal.aborted).toBe(false)
    await tick(IDLE_WAIT_MS)
    expect(signal.aborted).toBe(true)
  })

  test('arrow key as a single chunk never aborts', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b, 0x5b, 0x42]))
    await tick(IDLE_WAIT_MS)
    expect(signal.aborted).toBe(false)
  })

  test('arrow key split ESC | [B across chunks never aborts, even past the old 50ms', async () => {
    // The SSH freeze: a fragmented arrow key whose continuation lags. The CSI
    // parser must win regardless of inter-byte delay, so a late [B still cancels.
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    await tick(120)
    expect(signal.aborted).toBe(false)
    ctrl.onChunk(Buffer.from([0x5b, 0x42]))
    await tick(IDLE_WAIT_MS)
    expect(signal.aborted).toBe(false)
  })

  test('SS3 arrow (ESC O B) split across chunks never aborts', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    ctrl.onChunk(Buffer.from([0x4f, 0x42]))
    await tick(IDLE_WAIT_MS)
    expect(signal.aborted).toBe(false)
  })

  test('CSI follow-up byte cancels the pending abort', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    ctrl.onChunk(Buffer.from([0x5b, 0x41]))
    await tick(IDLE_WAIT_MS)
    expect(signal.aborted).toBe(false)
  })

  test('Ctrl-C surfaces sigint=true and never aborts the esc signal', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    const { sigint } = ctrl.onChunk(Buffer.from([0x03]))
    expect(sigint).toBe(true)
    await tick(IDLE_WAIT_MS)
    expect(signal.aborted).toBe(false)
  })

  test('q surfaces quit=true', () => {
    const ctrl = createEscController({ debounceMs: 10 })
    ctrl.armForStream()
    const { quit } = ctrl.onChunk(Buffer.from([0x71]))
    expect(quit).toBe(true)
  })

  test('incomplete CSI then Ctrl-C surfaces sigint instead of swallowing it', () => {
    // A truncated CSI (ESC [ with no final byte, e.g. dropped over SSH) must
    // not strand the parser consuming the user's exit key.
    const ctrl = createEscController({ debounceMs: 10 })
    ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b, 0x5b]))
    const { sigint } = ctrl.onChunk(Buffer.from([0x03]))
    expect(sigint).toBe(true)
  })

  test('incomplete SS3 then Ctrl-C surfaces sigint', () => {
    const ctrl = createEscController({ debounceMs: 10 })
    ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b, 0x4f]))
    const { sigint } = ctrl.onChunk(Buffer.from([0x03]))
    expect(sigint).toBe(true)
  })

  test('ESC mid-CSI resynchronizes to a new sequence (a following arrow does not abort)', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b, 0x5b])) // truncated CSI
    ctrl.onChunk(Buffer.from([0x1b, 0x5b, 0x42])) // resync: a full arrow-down
    await tick(IDLE_WAIT_MS)
    expect(signal.aborted).toBe(false)
  })

  test('complete CSI ending in q is consumed, not treated as quit', () => {
    // 0x71 'q' is a valid CSI final byte; inside a sequence it ends the
    // sequence rather than surfacing quit.
    const ctrl = createEscController({ debounceMs: 10 })
    ctrl.armForStream()
    const { quit } = ctrl.onChunk(Buffer.from([0x1b, 0x5b, 0x71]))
    expect(quit).toBe(false)
  })

  test('signal handed out by armForStream still aborts on ESC after clearPending → re-arm of listener (the picker pause/resume cycle)', async () => {
    // given: a stream is armed (caller stashes the signal as escSignal)
    const ctrl = createEscController({ debounceMs: 10 })
    const escSignal = ctrl.armForStream()
    // when: caller pauses the listener (picker opens) and later resumes it
    //       without re-arming — the original escSignal must remain bound to a
    //       live controller across this cycle
    ctrl.clearPending()
    // and: after resume the user presses a bare ESC during live tail
    ctrl.onChunk(Buffer.from([0x1b]))
    await tick(IDLE_WAIT_MS)
    // then: the signal the live source is listening on must abort.
    expect(escSignal.aborted).toBe(true)
  })

  test('armForStream after a previous arm: new signal aborts on ESC; old signal stays untouched', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const firstSignal = ctrl.armForStream()
    const secondSignal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    await tick(IDLE_WAIT_MS)
    expect(secondSignal.aborted).toBe(true)
    expect(firstSignal.aborted).toBe(false)
  })

  test('pending timer from a previous arm does not abort a freshly armed signal', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    const freshSignal = ctrl.armForStream()
    await tick(IDLE_WAIT_MS)
    expect(freshSignal.aborted).toBe(false)
  })

  test('dispose cancels any pending timer and detaches the controller', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    ctrl.onChunk(Buffer.from([0x1b]))
    ctrl.dispose()
    await tick(IDLE_WAIT_MS)
    expect(signal.aborted).toBe(false)
  })

  test('empty chunk is a no-op', async () => {
    const ctrl = createEscController({ debounceMs: 10 })
    const signal = ctrl.armForStream()
    const { sigint, quit } = ctrl.onChunk(Buffer.alloc(0))
    expect(sigint).toBe(false)
    expect(quit).toBe(false)
    await tick(IDLE_WAIT_MS)
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
      await tick(IDLE_WAIT_MS)
      expect(scope.intent()).toBe('back')
      expect(scope.signal.aborted).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  test('repeated arrow-down keys never trigger back/exit (the SSH freeze)', async () => {
    const tty = new FakeTty()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: fakeProc as never })
    try {
      // whole-chunk arrows
      tty.feed([0x1b, 0x5b, 0x42])
      tty.feed([0x1b, 0x5b, 0x42])
      // fragmented arrow with a lagging continuation
      tty.feed([0x1b])
      await tick(120)
      tty.feed([0x5b, 0x42])
      await tick(IDLE_WAIT_MS)
      expect(scope.intent()).toBeNull()
      expect(scope.signal.aborted).toBe(false)
    } finally {
      scope.dispose()
    }
  })

  test('ESC then q within the idle window exits, not back', () => {
    // Exit must win over a pending bare-ESC 'back'. Aborting on the ESC would
    // settle 'back' synchronously and swallow the q.
    const tty = new FakeTty()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: fakeProc as never })
    try {
      tty.feed([0x1b])
      tty.feed([0x71])
      expect(scope.intent()).toBe('exit')
    } finally {
      scope.dispose()
    }
  })

  test('ESC then Ctrl-C within the idle window exits, not back', () => {
    const tty = new FakeTty()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: fakeProc as never })
    try {
      tty.feed([0x1b])
      tty.feed([0x03])
      expect(scope.intent()).toBe('exit')
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
