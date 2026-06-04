import { resolveInspectTarget, type RunInspectOptions, type RunInspectResult, streamInspectTarget } from './index'

export type TailController = {
  signal: AbortSignal
  intent: () => 'back' | 'exit' | null
  dispose: () => void
}

export type RunInspectLoopOptions = Omit<RunInspectOptions, 'signal'> & {
  // Builds a fresh interaction scope for ONE live-tail attempt: a new
  // AbortController plus a temporary raw-mode listener. The loop creates it
  // only AFTER the picker has resolved a session and disposes it before the
  // picker re-opens, so clack always owns a clean, non-raw stdin — this is what
  // replaces the old pause/resume-same-controller model.
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
    const resolveOpts: Omit<RunInspectOptions, 'signal'> = { ...opts, selectSession: wrappedSelectSession }
    if (sessionArg !== undefined) resolveOpts.sessionIdOrPrefix = sessionArg
    else delete (resolveOpts as { sessionIdOrPrefix?: string }).sessionIdOrPrefix

    // Picker phase: cooked-mode stdin, no tail scope alive.
    const resolved = await resolveInspectTarget(resolveOpts)
    if (!resolved.ok) return resolved

    // Streaming phase: scope owns raw-mode stdin start-to-dispose, never
    // spanning the picker above or the next iteration's picker below.
    const scope = opts.createTailScope()
    let result: RunInspectResult
    try {
      result = await streamInspectTarget({ ...opts, target: resolved.target, signal: scope.signal })
    } finally {
      scope.dispose()
    }

    if (!result.ok) return result
    if (scope.intent() === 'exit') return result
    if (result.escToPicker !== true) return result
    sessionArg = undefined
  }
}
