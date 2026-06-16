import { describe, expect, test } from 'bun:test'

import { createTerminalGuard, RESTORE_SEQUENCE, type TerminalGuardDeps } from './terminal-guard'

type Listener = (...args: unknown[]) => void

function fakeDeps(overrides: Partial<TerminalGuardDeps> = {}): {
  deps: TerminalGuardDeps
  writes: string[]
  rawModes: boolean[]
  listeners: Map<string, Set<Listener>>
  killed: string[]
  exited: number[]
  emit: (event: string, ...args: unknown[]) => void
} {
  const writes: string[] = []
  const rawModes: boolean[] = []
  const listeners = new Map<string, Set<Listener>>()
  const killed: string[] = []
  const exited: number[] = []

  const emit = (event: string, ...args: unknown[]): void => {
    // oxlint-disable-next-line no-useless-spread -- snapshot so a handler can off() itself mid-emit
    for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
  }

  const deps: TerminalGuardDeps = {
    isTty: true,
    writeStdout: (seq) => writes.push(seq),
    setRawMode: (mode) => rawModes.push(mode),
    on: (event, handler) => {
      const set = listeners.get(event) ?? new Set<Listener>()
      set.add(handler)
      listeners.set(event, set)
    },
    off: (event, handler) => {
      listeners.get(event)?.delete(handler)
    },
    killSelf: (sig) => killed.push(sig),
    exit: (code) => {
      exited.push(code)
    },
    ...overrides,
  }

  return { deps, writes, rawModes, listeners, killed, exited, emit }
}

describe('createTerminalGuard', () => {
  test('arm installs an exit handler and the scoped signal handlers', () => {
    const { deps, listeners } = fakeDeps()
    const guard = createTerminalGuard(deps)

    guard.arm()

    expect(listeners.get('exit')?.size).toBe(1)
    expect(listeners.get('SIGINT')?.size).toBe(1)
    expect(listeners.get('SIGTERM')?.size).toBe(1)
    expect(listeners.get('SIGHUP')?.size).toBe(1)
  })

  test('exit handler writes the restore sequence and clears raw mode', () => {
    const { deps, writes, rawModes, emit } = fakeDeps()
    createTerminalGuard(deps).arm()

    emit('exit', 0)

    expect(writes).toEqual([RESTORE_SEQUENCE])
    expect(rawModes).toEqual([false])
  })

  test('restore sequence pops the Kitty keyboard protocol and shows the cursor', () => {
    // The leak symptom is the shell receiving Kitty key-RELEASE events; the pop
    // (\x1b[<u) is the load-bearing byte. Show-cursor and bracketed-paste-off
    // round out a full pi-tui ProcessTerminal.stop() reset.
    expect(RESTORE_SEQUENCE).toContain('\x1b[<u')
    expect(RESTORE_SEQUENCE).toContain('\x1b[?25h')
    expect(RESTORE_SEQUENCE).toContain('\x1b[?2004l')
  })

  test('a scoped signal restores, removes its own handler, then re-raises the signal', () => {
    const { deps, writes, listeners, killed, emit } = fakeDeps()
    createTerminalGuard(deps).arm()

    emit('SIGHUP')

    expect(writes).toEqual([RESTORE_SEQUENCE])
    // Handler removed before re-raise so the re-raised signal isn't swallowed.
    expect(listeners.get('SIGHUP')?.size ?? 0).toBe(0)
    expect(killed).toEqual(['SIGHUP'])
  })

  test('disarm removes scoped signal handlers but keeps the process-lifetime exit handler', () => {
    const { deps, listeners } = fakeDeps()
    const guard = createTerminalGuard(deps)

    guard.arm()
    guard.disarm()

    expect(listeners.get('SIGINT')?.size ?? 0).toBe(0)
    expect(listeners.get('SIGTERM')?.size ?? 0).toBe(0)
    expect(listeners.get('SIGHUP')?.size ?? 0).toBe(0)
    // The exit handler is sync, idempotent, and harmless — it stays installed so
    // a Bun process.exit() that drops pi-tui's buffered stop() writes is still
    // covered.
    expect(listeners.get('exit')?.size).toBe(1)
  })

  test('exit handler still restores after disarm (covers Bun-dropped clean-exit writes)', () => {
    const { deps, writes, emit } = fakeDeps()
    const guard = createTerminalGuard(deps)

    guard.arm()
    guard.disarm()
    emit('exit', 0)

    expect(writes).toEqual([RESTORE_SEQUENCE])
  })

  test('ref-counted arm/disarm keeps signal handlers until the last disarm', () => {
    const { deps, listeners } = fakeDeps()
    const guard = createTerminalGuard(deps)

    guard.arm()
    guard.arm()
    guard.disarm()
    expect(listeners.get('SIGINT')?.size).toBe(1)

    guard.disarm()
    expect(listeners.get('SIGINT')?.size ?? 0).toBe(0)
  })

  test('re-arming after a full disarm reinstalls scoped handlers without duplicating exit', () => {
    const { deps, listeners } = fakeDeps()
    const guard = createTerminalGuard(deps)

    guard.arm()
    guard.disarm()
    guard.arm()

    expect(listeners.get('exit')?.size).toBe(1)
    expect(listeners.get('SIGINT')?.size).toBe(1)
  })

  test('stays inert when stdout is not a TTY (no handlers, no writes)', () => {
    const { deps, writes, rawModes, listeners } = fakeDeps({ isTty: false })
    createTerminalGuard(deps).arm()

    expect(listeners.get('exit')?.size ?? 0).toBe(0)
    expect(listeners.get('SIGINT')?.size ?? 0).toBe(0)
    expect(writes).toEqual([])
    expect(rawModes).toEqual([])
  })
})
