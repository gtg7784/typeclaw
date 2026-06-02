import { runInspect, type RunInspectOptions, type RunInspectResult } from './index'

export type TailController = {
  signal: AbortSignal
  intent: () => 'back' | 'exit' | null
  dispose: () => void
}

export type RunInspectLoopOptions = Omit<RunInspectOptions, 'signal'> & {
  // Builds a fresh interaction scope for ONE live-tail attempt: a new
  // AbortController plus a temporary raw-mode listener. The loop disposes it
  // before the picker re-opens so clack always owns a clean, non-raw stdin —
  // this is what replaces the old pause/resume-same-controller model.
  createTailScope: () => TailController
}

export async function runInspectLoop(opts: RunInspectLoopOptions): Promise<RunInspectResult> {
  let sessionArg = opts.sessionIdOrPrefix
  let lastPickedId: string | undefined
  const wrappedSelectSession: typeof opts.selectSession = async (sessions, selectOpts) => {
    const hint = selectOpts?.initialSessionId ?? lastPickedId
    const picked = await opts.selectSession(sessions, hint !== undefined ? { initialSessionId: hint } : {})
    if (picked !== null) lastPickedId = picked.sessionId
    return picked
  }

  while (true) {
    const scope = opts.createTailScope()
    let result: RunInspectResult
    try {
      const callOpts: RunInspectOptions = {
        ...opts,
        selectSession: wrappedSelectSession,
        signal: scope.signal,
      }
      if (sessionArg !== undefined) callOpts.sessionIdOrPrefix = sessionArg
      else delete (callOpts as { sessionIdOrPrefix?: string }).sessionIdOrPrefix
      result = await runInspect(callOpts)
    } finally {
      scope.dispose()
    }

    if (!result.ok) return result
    if (scope.intent() === 'exit') return result
    if (result.escToPicker !== true) return result
    sessionArg = undefined
  }
}
