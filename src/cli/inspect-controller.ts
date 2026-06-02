// Pure controller for the inspect CLI's esc/ctrl-c key dispatch.
// Owns the AbortController lifecycle and the bare-ESC debounce timer,
// independent of process.stdin / TTY raw mode (which is wired in src/cli/inspect.ts).
// Extracted for testability: the lifecycle bug we want to pin is "armForStream's
// signal must remain valid across pause()/resume() cycles" — verifying that without
// a real TTY requires this seam.

export type EscChunkResult = { sigint: boolean }

export type EscController = {
  armForStream: () => AbortSignal
  onChunk: (chunk: Buffer) => EscChunkResult
  clearPending: () => void
  dispose: () => void
}

const QUIT_KEY = 0x71

export function createEscController({ debounceMs }: { debounceMs: number }): EscController {
  let currentCtrl: AbortController | null = null
  let pendingEsc: ReturnType<typeof setTimeout> | null = null

  const clearPending = (): void => {
    if (pendingEsc !== null) {
      clearTimeout(pendingEsc)
      pendingEsc = null
    }
  }

  return {
    armForStream: () => {
      clearPending()
      currentCtrl = new AbortController()
      return currentCtrl.signal
    },
    onChunk: (chunk) => {
      if (chunk.length === 0) return { sigint: false }
      if (chunk[0] === 0x03) {
        // Ctrl-C in raw mode arrives as a byte (terminal driver does not generate
        // SIGINT). Surface to the caller so it can re-issue SIGINT via the OS;
        // we deliberately keep the AbortController lifecycle separate from SIGINT.
        return { sigint: true }
      }
      if (chunk.length === 1 && chunk[0] === 0x1b) {
        // Bare ESC: schedule the abort. A follow-up byte within debounceMs (CSI
        // sequences from arrow keys, mouse, paste) cancels the pending fire.
        // Snapshot currentCtrl so a late-firing timer can't abort a controller
        // created by a subsequent armForStream() call.
        clearPending()
        const ctrl = currentCtrl
        pendingEsc = setTimeout(() => {
          pendingEsc = null
          ctrl?.abort()
        }, debounceMs)
        return { sigint: false }
      }
      // Any other byte arriving within the ESC window is the second byte of a CSI
      // sequence; cancel the pending abort.
      clearPending()
      return { sigint: false }
    },
    clearPending,
    dispose: () => {
      clearPending()
      currentCtrl = null
    },
  }
}

export type TailIntent = 'back' | 'exit'

export type TailScope = {
  signal: AbortSignal
  // null when the tail ended on its own (stream closed / replay-only); the loop
  // treats null the same as 'back'. The stream only ever sees signal.aborted —
  // intent is read by the loop, keeping abort decoupled from what abort meant.
  intent: () => TailIntent | null
  dispose: () => void
}

type RawInput = Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'resume' | 'on' | 'off'>

type ProcessSignals = Pick<NodeJS.Process, 'once' | 'off'>

// One disposable interaction scope per live-tail iteration. Creates a FRESH
// AbortController, installs a temporary raw-mode 'data' listener plus
// SIGINT/SIGTERM handlers, and tears all of it down on dispose(). This mirrors
// the `dreams` viewer-key pattern: raw mode is scoped to a single tail attempt
// and never survives into the clack picker, which removes the pause/resume
// state machine that made the old inspect listener fragile.
export function createTailScope(opts: { debounceMs: number; input?: RawInput; proc?: ProcessSignals }): TailScope {
  const stdin = opts.input ?? process.stdin
  const proc = opts.proc ?? process
  const controller = new AbortController()
  let intent: TailIntent | null = null
  let disposed = false

  const settle = (next: TailIntent): void => {
    if (intent === null) intent = next
    controller.abort()
  }

  const onSigExit = (): void => {
    settle('exit')
  }

  const isTty = Boolean(stdin.isTTY) && typeof stdin.setRawMode === 'function'
  const esc = isTty ? createEscController({ debounceMs: opts.debounceMs }) : null
  const escSignal = esc?.armForStream()
  // A bare ESC fires through the debounce controller, not the 'data' handler:
  // route its abort into 'back' intent here so the loop can re-open the picker.
  const onEscAbort = (): void => settle('back')

  const onData = (chunk: Buffer): void => {
    if (esc === null) return
    if (chunk[0] === QUIT_KEY) {
      // q mirrors dreams' quit key and is symmetric with Ctrl-C in live tail.
      settle('exit')
      return
    }
    const { sigint } = esc.onChunk(chunk)
    if (sigint) settle('exit')
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    proc.off('SIGINT', onSigExit)
    proc.off('SIGTERM', onSigExit)
    escSignal?.removeEventListener('abort', onEscAbort)
    if (esc !== null) {
      stdin.off('data', onData)
      esc.dispose()
      try {
        stdin.setRawMode(false)
      } catch {
        /* terminal already torn down */
      }
      // Deliberately NOT stdin.pause(): a paused process.stdin does not reliably
      // re-flow into the next clack picker under Bun (same reason as
      // prepareStdinForClack / dreams' waitForViewerKey). Leave it flowing.
    }
    // Abort last so a stream still awaiting on this signal unblocks during
    // teardown rather than hanging.
    controller.abort()
  }

  proc.once('SIGINT', onSigExit)
  proc.once('SIGTERM', onSigExit)

  if (esc !== null && escSignal !== undefined) {
    escSignal.addEventListener('abort', onEscAbort, { once: true })
    stdin.setRawMode(true)
    // Attach the data handler before resume() so no raw-mode keystroke slips
    // through between resuming the stream and registering the listener.
    stdin.on('data', onData)
    stdin.resume()
  }

  return {
    signal: controller.signal,
    intent: () => intent,
    dispose,
  }
}
