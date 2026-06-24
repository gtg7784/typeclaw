import type { ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { detectProviderError, subscribeProviderErrors } from './provider-error'
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
      try {
        await opts.session.prompt(opts.text)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const attempt: PersistentTurnAttempt = { ref, outcome: 'hard', errorMessage: error.message }
        attempts.push(attempt)
        lastError = error
        if (opts.shouldFailover(error)) circuit.recordThrottle({ profile: opts.profile, ref })
        if (isLast || !canAdvance(error, activity, opts.shouldFailover)) throw error
        opts.onAttemptFailed?.(attempt)
        continue
      }
      if (softError !== undefined) {
        const attempt: PersistentTurnAttempt = { ref, outcome: 'soft', errorMessage: softError.message }
        attempts.push(attempt)
        lastError = softError
        if (opts.shouldFailover(softError)) circuit.recordThrottle({ profile: opts.profile, ref })
        if (isLast || !canAdvance(softError, activity, opts.shouldFailover)) {
          return { success: false, refUsed: ref, attempts, lastError }
        }
        opts.onAttemptFailed?.(attempt)
        continue
      }
      const leafSoftError = opts.detectSoftErrorFromLeaf ? detectLeafSoftError(opts.session) : undefined
      if (leafSoftError !== undefined) {
        const attempt: PersistentTurnAttempt = { ref, outcome: 'soft', errorMessage: leafSoftError.message }
        attempts.push(attempt)
        lastError = leafSoftError
        if (opts.shouldFailover(leafSoftError)) circuit.recordThrottle({ profile: opts.profile, ref })
        if (isLast || !canAdvance(leafSoftError, activity, opts.shouldFailover)) {
          return { success: false, refUsed: ref, attempts, lastError }
        }
        opts.onAttemptFailed?.(attempt)
        continue
      }
      attempts.push({ ref, outcome: 'success' })
      circuit.recordSuccess({ profile: opts.profile, ref })
      return { success: true, refUsed: ref, attempts }
    } finally {
      unsubProvider()
      unsubActivity()
    }
  }
  return { success: false, refUsed: opts.refs[opts.refs.length - 1]!, attempts, lastError }
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
