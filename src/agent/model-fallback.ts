import { resolveProfile } from '@/config'
import type { Models } from '@/config/config'
import type { KnownModelRef, ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { subscribeProviderErrors } from './provider-error'
import { renderTurnTimeAnchor } from './system-prompt'

// Result of a single fallback-aware prompt run.
// - `refUsed` is the ref whose session ultimately handled the turn.
// - `attempts` lists every ref that was tried, in order, with the failure
//   reason for each attempt that didn't make it through. `attempts.length`
//   is always >= 1; the last entry succeeded iff `success: true`.
// - `session` / `dispose` are the session that handled the turn (or attempted
//   the final entry, on full-chain failure). Callers that need to keep using
//   the session for subsequent turns store these in their state; callers that
//   tear down per-turn (cron) just call `dispose()` and discard.
type FallbackModelRef = KnownModelRef | ModelRef

export type FallbackPromptResult<TRef extends FallbackModelRef = ModelRef> = {
  success: boolean
  refUsed: TRef
  attempts: FallbackAttempt<TRef>[]
  session: AgentSession
  dispose: () => Promise<void>
  // When `success === false`, this is the error from the final attempt.
  lastError?: Error
}

export type FallbackAttempt<TRef extends FallbackModelRef = ModelRef> = {
  ref: TRef
  // 'hard' = session.prompt() threw. 'soft' = pi-coding-agent surfaced an
  // upstream error via stopReason: 'error' on the final assistant message.
  // 'success' = the turn finished cleanly.
  outcome: 'hard' | 'soft' | 'success'
  errorMessage?: string
}

// Build the ordered list of refs to attempt for a given profile. Single-ref
// profiles produce a length-1 chain; the fallback path is then a no-op in
// practice (the first attempt either succeeds or the error propagates).
//
// Exported so callers can introspect the chain (e.g. logs, telemetry) before
// firing the prompt — useful for `[cron] ${jobId}: trying chain a → b → c`.
export function resolveFallbackChain(models: Models, profile: string | undefined): ModelRef[] {
  return resolveProfile(models, profile).refs
}

// Drives one `session.prompt(text)` call with full fallback semantics:
//
//   1. Create a session bound to `refs[0]` via `createSessionForRef`.
//   2. Subscribe to provider-error events so soft errors (pi-coding-agent's
//      `stopReason: 'error'` shape) trigger fallback in addition to throws.
//   3. Await `session.prompt(text)`.
//   4. If the prompt threw OR a soft error fired during the turn:
//      - dispose the failed session
//      - advance to `refs[i+1]` and retry (only if a fallback is available)
//   5. Return the session that handled the turn (or the last-tried session
//      on full-chain failure), the ref used, and the attempt log.
//
// The wrapper intentionally does NOT swallow the final failure: when every
// ref in the chain has been exhausted, the returned `success: false` plus
// `lastError` lets the caller surface the failure however it already does
// (console.error in the server drain, channel reaction in the router,
// cron-job status). This keeps the helper composable with the existing
// error-handling code at each call site.
export async function promptWithFallback<TRef extends FallbackModelRef>(opts: {
  refs: TRef[]
  text: string
  createSessionForRef: (ref: TRef) => Promise<{ session: AgentSession; dispose: () => Promise<void> }>
  // Called after each non-final attempt so callers can log the per-attempt
  // failure with their own context (sessionId, channel key, job id, ...).
  onAttemptFailed?: (attempt: FallbackAttempt<TRef>) => void
}): Promise<FallbackPromptResult<TRef>> {
  if (opts.refs.length === 0) {
    throw new Error('promptWithFallback: refs[] must be non-empty')
  }
  const attempts: FallbackAttempt<TRef>[] = []
  let lastError: Error | undefined
  for (let i = 0; i < opts.refs.length; i++) {
    const ref = opts.refs[i]!
    const isLast = i === opts.refs.length - 1
    const { session, dispose } = await opts.createSessionForRef(ref)
    // Capture the first soft error per attempt. The `subscribeProviderErrors`
    // listener fires synchronously off the `message_end` event, which lands
    // BEFORE `session.prompt()` resolves — so by the time `await` returns,
    // `softError` is populated if a soft error occurred.
    let softError: Error | undefined
    const unsub = subscribeProviderErrors(session, (err) => {
      if (!softError) softError = new Error(err.message)
    })
    try {
      try {
        await session.prompt(`${renderTurnTimeAnchor()}\n\n${opts.text}`)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const attempt: FallbackAttempt<TRef> = { ref, outcome: 'hard', errorMessage: error.message }
        attempts.push(attempt)
        lastError = error
        if (!isLast) opts.onAttemptFailed?.(attempt)
        unsub()
        await dispose()
        if (isLast) {
          return { success: false, refUsed: ref, attempts, session, dispose: async () => {}, lastError }
        }
        continue
      }
      if (softError !== undefined) {
        const attempt: FallbackAttempt<TRef> = { ref, outcome: 'soft', errorMessage: softError.message }
        attempts.push(attempt)
        lastError = softError
        if (!isLast) opts.onAttemptFailed?.(attempt)
        unsub()
        await dispose()
        if (isLast) {
          return { success: false, refUsed: ref, attempts, session, dispose: async () => {}, lastError }
        }
        continue
      }
      attempts.push({ ref, outcome: 'success' })
      unsub()
      return { success: true, refUsed: ref, attempts, session, dispose }
    } catch (err) {
      unsub()
      await dispose()
      throw err
    }
  }
  throw new Error('promptWithFallback: unreachable — loop terminated without returning')
}
