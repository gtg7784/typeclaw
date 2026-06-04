// Pure controller for the inspect CLI's esc/ctrl-c/quit key dispatch.
// Owns the AbortController lifecycle and a VT-input parser, independent of
// process.stdin / TTY raw mode (which is wired in src/cli/inspect.ts).
//
// Input is parsed byte-by-byte through a small escape-sequence state machine so
// that arrow keys and other CSI/SS3 sequences can never be mistaken for a bare
// ESC — regardless of how the bytes are split across 'data' events. The old
// implementation used a 50ms wall-clock debounce to tell "ESC" from "ESC ["; on
// a laggy SSH link the inter-byte gap of a single arrow key routinely exceeds
// 50ms, so the leading ESC fired 'back' mid-keystroke and bounced the user out
// of the viewer. The parser below makes CSI/SS3 always win, with a much longer
// idle fallback used ONLY to resolve a genuinely-trailing bare ESC.

export type EscChunkResult = { sigint: boolean; quit: boolean }

export type EscController = {
  armForStream: () => AbortSignal
  onChunk: (chunk: Buffer) => EscChunkResult
  clearPending: () => void
  dispose: () => void
}

const ESC = 0x1b
const CSI_INTRODUCER = 0x5b
const SS3_INTRODUCER = 0x4f
const CTRL_C = 0x03
const QUIT_KEY = 0x71

type ParseState = 'idle' | 'sawEsc' | 'csi' | 'ss3'

// A CSI sequence ends at a final byte in 0x40..0x7e (e.g. arrow keys 'A'..'D',
// '~' for nav keys, 'M'/'m' for mouse). Parameter/intermediate bytes (0x20..0x3f)
// are consumed without ending it.
function isCsiFinal(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e
}

// C0 controls (0x00..0x1f plus DEL 0x7f) are not legal sequence-body bytes.
function isC0Control(byte: number): boolean {
  return byte <= 0x1f || byte === 0x7f
}

export function createEscController({ debounceMs }: { debounceMs: number }): EscController {
  let currentCtrl: AbortController | null = null
  let state: ParseState = 'idle'
  let pendingEsc: ReturnType<typeof setTimeout> | null = null
  // A trailing ESC with no following byte cannot be proven "bare" without
  // waiting. Use a generous idle window (>= debounceMs) so SSH-fragmented
  // sequences whose continuation is still in flight are never misread.
  const bareEscIdleMs = Math.max(debounceMs, 500)

  const clearPending = (): void => {
    if (pendingEsc !== null) {
      clearTimeout(pendingEsc)
      pendingEsc = null
    }
    state = 'idle'
  }

  const scheduleBareEsc = (): void => {
    if (pendingEsc !== null) clearTimeout(pendingEsc)
    const ctrl = currentCtrl
    pendingEsc = setTimeout(() => {
      pendingEsc = null
      state = 'idle'
      ctrl?.abort()
    }, bareEscIdleMs)
  }

  const cancelPendingTimer = (): void => {
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
      let sigint = false
      let quit = false
      for (const byte of chunk) {
        switch (state) {
          case 'idle':
            if (byte === ESC) {
              state = 'sawEsc'
              scheduleBareEsc()
            } else if (byte === CTRL_C) {
              sigint = true
            } else if (byte === QUIT_KEY) {
              quit = true
            }
            break
          case 'sawEsc':
            if (byte === CSI_INTRODUCER) {
              cancelPendingTimer()
              state = 'csi'
            } else if (byte === SS3_INTRODUCER) {
              cancelPendingTimer()
              state = 'ss3'
            } else if (byte === CTRL_C || byte === QUIT_KEY) {
              // ESC then an exit key: exit must win over the pending bare-ESC
              // 'back'. Drop the pending ESC WITHOUT aborting (abort would settle
              // 'back' synchronously and pre-empt the exit), and surface the key.
              cancelPendingTimer()
              state = 'idle'
              if (byte === CTRL_C) sigint = true
              else quit = true
            } else if (byte === ESC) {
              // The first ESC was bare; abort now and keep this ESC pending.
              cancelPendingTimer()
              currentCtrl?.abort()
              state = 'sawEsc'
              scheduleBareEsc()
            } else {
              // ESC + an ordinary byte: the ESC was bare. Abort to 'back' and
              // drop the trailing byte (e.g. Alt+key is treated as a bare ESC).
              cancelPendingTimer()
              currentCtrl?.abort()
              state = 'idle'
            }
            break
          case 'csi':
          case 'ss3':
            // A C0 control byte is never a legal part of a CSI/SS3 body. A
            // truncated or malformed sequence (e.g. dropped final byte over a
            // lossy SSH link) must not strand the parser swallowing the user's
            // exit keys. ESC resynchronizes to a new sequence; Ctrl-C surfaces
            // immediately; any other C0 control just abandons the sequence.
            if (byte === ESC) {
              state = 'sawEsc'
              scheduleBareEsc()
            } else if (byte === CTRL_C) {
              cancelPendingTimer()
              state = 'idle'
              sigint = true
            } else if (isC0Control(byte)) {
              cancelPendingTimer()
              state = 'idle'
            } else if (state === 'csi') {
              if (isCsiFinal(byte)) state = 'idle'
            } else {
              // SS3 carries exactly one final byte (e.g. application-mode arrows).
              state = 'idle'
            }
            break
        }
      }
      return { sigint, quit }
    },
    clearPending,
    dispose: () => {
      cancelPendingTimer()
      state = 'idle'
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
    // Route every byte through the parser so arrow keys (CSI/SS3) are consumed
    // as no-ops and q/ctrl-c are detected even when batched with other bytes.
    // q mirrors dreams' quit key and is symmetric with Ctrl-C in live tail.
    const { sigint, quit } = esc.onChunk(chunk)
    if (sigint || quit) settle('exit')
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
