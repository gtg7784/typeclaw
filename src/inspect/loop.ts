import { runInspect, type RunInspectOptions, type RunInspectResult } from './index'

export type RunInspectLoopOptions = Omit<RunInspectOptions, 'escSignal'> & {
  newEscSignal: () => AbortSignal
  // Runs after every runInspect attempt settles. The caller disarms the raw-mode
  // ESC listener here so the live tail releases stdin before clack re-opens the
  // picker: an ESC-aborted tail leaves the listener armed (raw mode on, 'data'
  // handler attached), and handing clack that flowing stream freezes the picker
  // on SSH/Bun pseudo-TTYs.
  afterEscStream?: () => void
}

export async function runInspectLoop(opts: RunInspectLoopOptions): Promise<RunInspectResult> {
  let sessionArg = opts.sessionIdOrPrefix
  // Remember the last session the user picked from the interactive picker so
  // an ESC-back-to-picker re-opens with that row pre-selected. The picker
  // receives this through the `initialSessionId` hint on its second arg.
  let lastPickedId: string | undefined
  const wrappedSelectSession: typeof opts.selectSession = async (sessions, selectOpts) => {
    const hint = selectOpts?.initialSessionId ?? lastPickedId
    const picked = await opts.selectSession(sessions, hint !== undefined ? { initialSessionId: hint } : {})
    if (picked !== null) lastPickedId = picked.sessionId
    return picked
  }

  while (true) {
    const escSignal = opts.newEscSignal()
    const callOpts: RunInspectOptions = { ...opts, escSignal, selectSession: wrappedSelectSession }
    if (sessionArg !== undefined) callOpts.sessionIdOrPrefix = sessionArg
    else delete (callOpts as { sessionIdOrPrefix?: string }).sessionIdOrPrefix

    let result: RunInspectResult
    try {
      result = await runInspect(callOpts)
    } finally {
      opts.afterEscStream?.()
    }
    if (!result.ok) return result
    if (result.escToPicker !== true) return result
    sessionArg = undefined
  }
}
