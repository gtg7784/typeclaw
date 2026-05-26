import { runInspect, type RunInspectOptions, type RunInspectResult } from './index'

export type RunInspectLoopOptions = Omit<RunInspectOptions, 'escSignal'> & {
  newEscSignal: () => AbortSignal
}

export async function runInspectLoop(opts: RunInspectLoopOptions): Promise<RunInspectResult> {
  let sessionArg = opts.sessionIdOrPrefix
  while (true) {
    const escSignal = opts.newEscSignal()
    const callOpts: RunInspectOptions = { ...opts, escSignal }
    if (sessionArg !== undefined) callOpts.sessionIdOrPrefix = sessionArg
    else delete (callOpts as { sessionIdOrPrefix?: string }).sessionIdOrPrefix

    const result = await runInspect(callOpts)
    if (!result.ok) return result
    if (result.escToPicker !== true) return result
    sessionArg = undefined
  }
}
