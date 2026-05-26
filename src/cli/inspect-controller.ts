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
