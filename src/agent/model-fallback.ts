import { resolveProfile } from '@/config'
import type { Models } from '@/config/config'
import type { KnownModelRef, ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { isRetryableSameRef, subscribeProviderErrors } from './provider-error'
import { RETRIES_PER_REF, sleepBackoff } from './retry-same-ref'
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
  // Gate that decides whether a given failure is worth advancing the chain.
  // Omitted (cron) means "advance on any error" — the original behavior.
  // Interactive callers pass `isThrottleOrOverload` so a one-off real error
  // (billing, malformed response) surfaces on the active ref instead of
  // silently switching providers.
  shouldFailover?: (err: Error) => boolean
}): Promise<FallbackPromptResult<TRef>> {
  if (opts.refs.length === 0) {
    throw new Error('promptWithFallback: refs[] must be non-empty')
  }
  const failoverGate = opts.shouldFailover ?? (() => true)
  const attempts: FallbackAttempt<TRef>[] = []
  let lastError: Error | undefined
  for (let i = 0; i < opts.refs.length; i++) {
    const ref = opts.refs[i]!
    const isLast = i === opts.refs.length - 1
    // Try this ref, replaying the SAME ref on a transient failure before we give
    // up on it. Cron sessions are cheap and fresh-per-attempt, so a same-ref
    // retry just recreates the session — no state surgery needed.
    const outcome = await attemptRefWithRetry(ref, opts)
    if (outcome.kind === 'success') {
      attempts.push({ ref, outcome: 'success' })
      return { success: true, refUsed: ref, attempts, session: outcome.session, dispose: outcome.dispose }
    }
    attempts.push({ ref, outcome: outcome.kind, errorMessage: outcome.error.message })
    lastError = outcome.error
    const stop = isLast || !failoverGate(outcome.error)
    if (!stop) opts.onAttemptFailed?.({ ref, outcome: outcome.kind, errorMessage: outcome.error.message })
    // The failed ref's session is spent either way — dispose it. On stop we still
    // hand the caller the (now-disposed) session for its final surface, with a
    // no-op dispose so a double-dispose can't happen.
    await outcome.dispose()
    if (stop) {
      return { success: false, refUsed: ref, attempts, session: outcome.session, dispose: async () => {}, lastError }
    }
  }
  throw new Error('promptWithFallback: unreachable — loop terminated without returning')
}

type RefAttemptOutcome =
  | { kind: 'success'; session: AgentSession; dispose: () => Promise<void> }
  | { kind: 'hard' | 'soft'; error: Error; session: AgentSession; dispose: () => Promise<void> }

// One ref, with same-ref retry. Each attempt gets a fresh session (cron's
// pattern); a retryable failure disposes it and recreates the same ref up to
// RETRIES_PER_REF times before returning failure to the chain. The returned
// session/dispose is always from the LAST attempt so the caller can surface or
// keep it exactly as before.
async function attemptRefWithRetry<TRef extends FallbackModelRef>(
  ref: TRef,
  opts: {
    text: string
    createSessionForRef: (ref: TRef) => Promise<{ session: AgentSession; dispose: () => Promise<void> }>
  },
): Promise<RefAttemptOutcome> {
  for (let attempt = 0; ; attempt++) {
    const { session, dispose } = await opts.createSessionForRef(ref)
    // Capture the first soft error per attempt. The listener fires synchronously
    // off `message_end`, which lands BEFORE `session.prompt()` resolves, so by
    // the time `await` returns `softError` is populated if one occurred.
    let softError: Error | undefined
    const unsub = subscribeProviderErrors(session, (err) => {
      if (!softError) softError = new Error(err.message)
    })
    let outcome: RefAttemptOutcome
    try {
      await session.prompt(`${renderTurnTimeAnchor()}\n\n${opts.text}`)
      outcome =
        softError === undefined
          ? { kind: 'success', session, dispose }
          : { kind: 'soft', error: softError, session, dispose }
    } catch (err) {
      outcome = { kind: 'hard', error: err instanceof Error ? err : new Error(String(err)), session, dispose }
    } finally {
      unsub()
    }
    if (outcome.kind === 'success') return outcome
    const canRetry = attempt < RETRIES_PER_REF && isRetryableSameRef(outcome.error.message)
    if (!canRetry) return outcome
    // Retryable and budget remains: drop this session and replay the same ref.
    await dispose()
    await sleepBackoff(attempt)
  }
}
