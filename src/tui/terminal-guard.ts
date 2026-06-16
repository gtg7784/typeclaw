import { writeSync } from 'node:fs'

// Mirrors pi-tui ProcessTerminal.stop()'s resets so an abnormal exit (SSH
// SIGHUP, a frozen TUI the user kills, a crash, or a Bun process.exit() that
// drops pi-tui's buffered stop() writes) can't leave the parent shell with the
// Kitty keyboard protocol still on. While on, the terminal emits CSI-u
// key-RELEASE events (`;1:3u`) for every keystroke, corrupting the shell. Order
// matches stop(): pop Kitty kbd protocol, disable xterm modifyOtherKeys, disable
// bracketed paste, end synchronized output, show cursor.
export const RESTORE_SEQUENCE = '\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?2026l\x1b[?25h'

const STDOUT_FD = 1

const SCOPED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
export type ScopedSignal = (typeof SCOPED_SIGNALS)[number]

const SIGNAL_EXIT_CODE: Record<ScopedSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
}

export type TerminalGuardDeps = {
  isTty: boolean
  writeStdout: (seq: string) => void
  setRawMode: (mode: boolean) => void
  on: (event: string, handler: (...args: unknown[]) => void) => void
  off: (event: string, handler: (...args: unknown[]) => void) => void
  killSelf: (signal: ScopedSignal) => void
  exit: (code: number) => void
}

export type TerminalGuard = {
  arm: () => void
  disarm: () => void
}

export function createTerminalGuard(deps: TerminalGuardDeps): TerminalGuard {
  let armed = 0
  let exitInstalled = false
  let signalHandlers: Map<ScopedSignal, (...args: unknown[]) => void> | null = null

  const restore = (): void => {
    if (!deps.isTty) return
    deps.writeStdout(RESTORE_SEQUENCE)
    deps.setRawMode(false)
  }

  const onExit = (): void => {
    restore()
  }

  const installSignalHandlers = (): void => {
    if (signalHandlers !== null) return
    const handlers = new Map<ScopedSignal, (...args: unknown[]) => void>()
    for (const sig of SCOPED_SIGNALS) {
      const handler = (): void => {
        // Restore the terminal, then let the signal terminate with default
        // semantics. Remove our handlers first so the re-raised signal isn't
        // swallowed by this same handler; fall back to an explicit exit if the
        // re-raise somehow doesn't terminate.
        removeSignalHandlers()
        restore()
        deps.killSelf(sig)
        deps.exit(SIGNAL_EXIT_CODE[sig])
      }
      deps.on(sig, handler)
      handlers.set(sig, handler)
    }
    signalHandlers = handlers
  }

  const removeSignalHandlers = (): void => {
    if (signalHandlers === null) return
    for (const [sig, handler] of signalHandlers) deps.off(sig, handler)
    signalHandlers = null
  }

  return {
    arm: () => {
      // A non-TTY process (piped/redirected, or the test runner) has no terminal
      // state to protect, so the guard stays fully inert — it never touches the
      // real process signal/exit handlers.
      if (!deps.isTty) return
      armed += 1
      if (!exitInstalled) {
        deps.on('exit', onExit)
        exitInstalled = true
      }
      installSignalHandlers()
    },
    disarm: () => {
      if (!deps.isTty) return
      if (armed > 0) armed -= 1
      if (armed === 0) removeSignalHandlers()
    },
  }
}

let defaultGuard: TerminalGuard | null = null

function getDefaultGuard(): TerminalGuard {
  defaultGuard ??= createTerminalGuard({
    isTty: Boolean(process.stdout.isTTY),
    writeStdout: (seq) => {
      try {
        writeSync(STDOUT_FD, seq)
      } catch {
        /* fd closed mid-teardown */
      }
    },
    setRawMode: (mode) => {
      try {
        process.stdin.setRawMode?.(mode)
      } catch {
        /* terminal already torn down */
      }
    },
    on: (event, handler) => {
      process.on(event as NodeJS.Signals, handler)
    },
    off: (event, handler) => {
      process.off(event as NodeJS.Signals, handler)
    },
    killSelf: (signal) => {
      process.kill(process.pid, signal)
    },
    exit: (code) => {
      process.exit(code)
    },
  })
  return defaultGuard
}

export function armTerminalGuard(): TerminalGuard {
  const guard = getDefaultGuard()
  guard.arm()
  return guard
}
