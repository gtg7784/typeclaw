import type { ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { detectProviderError, isRetryableSameRef, subscribeProviderErrors } from './provider-error'
import { RETRIES_PER_REF, retryTurnAfterCompletedToolResult, retryTurnOnPersistentSession } from './retry-same-ref'
import { modelThrottleCircuit, type ThrottleCircuit } from './throttle-circuit'

export type PersistentTurnAttempt = {
  ref: ModelRef
  outcome: 'hard' | 'soft' | 'success'
  errorMessage?: string
}

export type PersistentTurnResult = {
  success: boolean
  refUsed: ModelRef
  attempts: PersistentTurnAttempt[]
  lastError?: Error
}

type AttemptActivity = {
  producedAssistantOutput: boolean
  startedToolExecution: boolean
}

export async function promptPersistentTurnWithFallback(opts: {
  refs: ModelRef[]
  currentModelRef: ModelRef
  session: AgentSession
  text: string
  shouldFailover: (err: Error) => boolean
  setModelForRef: (ref: ModelRef) => Promise<void>
  profile?: string
  circuit?: ThrottleCircuit
  skipProviderErrorSubscription?: boolean
  detectSoftErrorFromLeaf?: boolean
  authorizeRetryAfterCompletedToolResult?: () => boolean
  retryRandom?: () => number
  onRetryBackoffStart?: () => void
  beforeAttempt?: (ref: ModelRef) => void
  onAttemptFailed?: (attempt: PersistentTurnAttempt) => void
}): Promise<PersistentTurnResult> {
  if (opts.refs.length === 0) throw new Error('promptPersistentTurnWithFallback: refs[] must be non-empty')
  const attempts: PersistentTurnAttempt[] = []
  let lastError: Error | undefined
  const circuit = opts.circuit ?? modelThrottleCircuit
  // The model the session currently has loaded; only call setModel when the
  // chosen ref differs from it. Tracked locally so successive setModel calls
  // within a single turn stay coherent.
  let loadedRef = opts.currentModelRef
  // Always start from the head of the chain so a recovered primary is probed
  // again (the circuit breaker, not a sticky start index, decides when to skip
  // a still-throttled ref). Starting at the previous turn's fallback would make
  // a one-time failover permanent and never let the cooldown/half-open path
  // re-test the primary.
  for (let i = 0; i < opts.refs.length; i++) {
    const ref = opts.refs[i]!
    const isLast = i === opts.refs.length - 1
    // Skip a ref whose circuit is open, but never skip the last one — there is
    // nowhere left to fall, so we try it regardless and let the result speak.
    if (!isLast && circuit.isOpen({ profile: opts.profile, ref })) continue
    if (ref !== loadedRef) {
      await opts.setModelForRef(ref)
      loadedRef = ref
    }
    opts.beforeAttempt?.(ref)
    const activity: AttemptActivity = { producedAssistantOutput: false, startedToolExecution: false }
    let softError: Error | undefined
    // Activity tracking ALWAYS runs — the idempotency guard must hold even for
    // subagents. `skipProviderErrorSubscription` only suppresses the soft-error
    // listener (subagents capture their final message off the leaf instead, via
    // detectSoftErrorFromLeaf, so a second listener would race that capture).
    const unsubActivity = subscribeAttemptActivity(opts.session, activity)
    const unsubProvider = opts.skipProviderErrorSubscription
      ? () => {}
      : subscribeProviderErrorsIfAvailable(opts.session, (err) => {
          if (softError === undefined) softError = new Error(err.message)
        })
    try {
      // Same-ref retry loop: replay this ref on a transient failure before
      // advancing the chain. `retry === 0` is the first, prompt()-driven attempt;
      // later iterations resume via agent.continue() (no user-message re-append).
      let outcome: AttemptOutcome | undefined
      let retryAfterCompletedToolResult = false
      for (let retry = 0; ; retry++) {
        softError = undefined
        let outcomeThisAttempt: AttemptOutcome | undefined
        try {
          if (retry === 0) {
            await opts.session.prompt(opts.text)
          } else {
            const retried = retryAfterCompletedToolResult
              ? await retryTurnAfterCompletedToolResult(opts.session, {
                  attempt: retry - 1,
                  authorize: () => opts.authorizeRetryAfterCompletedToolResult?.() === true,
                  ...(opts.retryRandom !== undefined ? { random: opts.retryRandom } : {}),
                  ...(opts.onRetryBackoffStart !== undefined ? { onBackoffStart: opts.onRetryBackoffStart } : {}),
                })
              : await retryTurnOnPersistentSession(opts.session, { attempt: retry - 1 })
            // The safe continue-recipe couldn't apply: keep the PREVIOUS failure
            // outcome (never cleared) and let it drive the advance/return below.
            if (!retried) break
          }
          outcomeThisAttempt = classifySoftOutcome(softError, opts)
        } catch (err) {
          outcomeThisAttempt = { kind: 'hard', error: err instanceof Error ? err : new Error(String(err)) }
        }
        outcome = outcomeThisAttempt
        if (outcome === undefined) break
        // Retry within budget only when the failure is same-ref retryable and
        // either no visible/tool activity occurred, or the caller explicitly
        // authorizes the strict post-tool-result resume recipe.
        const retryableWithinBudget = retry < RETRIES_PER_REF && isRetryableSameRef(outcome.error.message)
        const mayRetryWithoutActivity = !activity.producedAssistantOutput && !activity.startedToolExecution
        retryAfterCompletedToolResult =
          retryableWithinBudget &&
          activity.startedToolExecution &&
          opts.authorizeRetryAfterCompletedToolResult?.() === true
        const mayRetry = retryableWithinBudget && (mayRetryWithoutActivity || retryAfterCompletedToolResult)
        if (!mayRetry) break
      }

      if (outcome === undefined) {
        attempts.push({ ref, outcome: 'success' })
        circuit.recordSuccess({ profile: opts.profile, ref })
        return { success: true, refUsed: ref, attempts }
      }

      // Ref abandoned after exhausting same-ref retries. Record throttle ONCE
      // here (not per internal retry) so a single turn can't self-trip the
      // circuit breaker.
      const attempt: PersistentTurnAttempt = { ref, outcome: outcome.kind, errorMessage: outcome.error.message }
      attempts.push(attempt)
      lastError = outcome.error
      if (opts.shouldFailover(outcome.error)) circuit.recordThrottle({ profile: opts.profile, ref })
      if (isLast || !canAdvance(outcome.error, activity, opts.shouldFailover)) {
        if (outcome.kind === 'hard') throw outcome.error
        return { success: false, refUsed: ref, attempts, lastError }
      }
      opts.onAttemptFailed?.(attempt)
      continue
    } finally {
      unsubProvider()
      unsubActivity()
    }
  }
  return { success: false, refUsed: opts.refs[opts.refs.length - 1]!, attempts, lastError }
}

type AttemptOutcome = { kind: 'hard' | 'soft'; error: Error }

// Classify a completed (non-throwing) attempt: a captured soft error, else a
// leaf soft error (subagent path), else success (undefined). Mirrors the two
// soft-error sources the loop handled inline before the retry refactor.
function classifySoftOutcome(
  softError: Error | undefined,
  opts: { session: AgentSession; detectSoftErrorFromLeaf?: boolean },
): AttemptOutcome | undefined {
  if (softError !== undefined) return { kind: 'soft', error: softError }
  const leafSoftError = opts.detectSoftErrorFromLeaf ? detectLeafSoftError(opts.session) : undefined
  if (leafSoftError !== undefined) return { kind: 'soft', error: leafSoftError }
  return undefined
}

function canAdvance(error: Error, activity: AttemptActivity, shouldFailover: (err: Error) => boolean): boolean {
  return shouldFailover(error) && !activity.producedAssistantOutput && !activity.startedToolExecution
}

function subscribeAttemptActivity(session: AgentSession, activity: AttemptActivity): () => void {
  const subscribe = (session as { subscribe?: unknown }).subscribe
  if (typeof subscribe !== 'function') return () => {}
  return session.subscribe((event: unknown) => {
    if (!isRecord(event)) return
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      activity.startedToolExecution = true
      return
    }
    if (event.type !== 'message_update') return
    const assistantMessageEvent = event.assistantMessageEvent
    if (!isRecord(assistantMessageEvent)) return
    if (assistantMessageEvent.type === 'text_delta' && typeof assistantMessageEvent.delta === 'string') {
      if (assistantMessageEvent.delta.length > 0) activity.producedAssistantOutput = true
    }
  })
}

function subscribeProviderErrorsIfAvailable(
  session: AgentSession,
  onError: Parameters<typeof subscribeProviderErrors>[1],
): () => void {
  const subscribe = (session as { subscribe?: unknown }).subscribe
  if (typeof subscribe !== 'function') return () => {}
  return subscribeProviderErrors(session, onError)
}

function detectLeafSoftError(session: AgentSession): Error | undefined {
  const leaf = session.sessionManager?.getLeafEntry()
  if (!leaf || leaf.type !== 'message') return undefined
  const detected = detectProviderError(leaf.message)
  return detected === null ? undefined : new Error(detected.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
