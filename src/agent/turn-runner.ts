import type { ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { subscribeProviderErrors } from './provider-error'
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
  currentRef: ModelRef
  session: AgentSession
  text: string
  shouldFailover: (err: Error) => boolean
  setModelForRef: (ref: ModelRef) => Promise<void>
  profile?: string
  circuit?: ThrottleCircuit
  skipEventSubscriptions?: boolean
  beforeAttempt?: (ref: ModelRef) => void
  onAttemptFailed?: (attempt: PersistentTurnAttempt) => void
}): Promise<PersistentTurnResult> {
  if (opts.refs.length === 0) throw new Error('promptPersistentTurnWithFallback: refs[] must be non-empty')
  const start = Math.max(0, opts.refs.indexOf(opts.currentRef))
  const attempts: PersistentTurnAttempt[] = []
  let lastError: Error | undefined
  const circuit = opts.circuit ?? modelThrottleCircuit
  for (let i = start; i < opts.refs.length; i++) {
    let ref = opts.refs[i]!
    let modelSetForAttempt = i === start
    while (i < opts.refs.length - 1 && circuit.isOpen({ profile: opts.profile, ref })) {
      i++
      ref = opts.refs[i]!
      await opts.setModelForRef(ref)
      modelSetForAttempt = true
    }
    const isLast = i === opts.refs.length - 1
    if (!modelSetForAttempt) await opts.setModelForRef(ref)
    opts.beforeAttempt?.(ref)
    const activity: AttemptActivity = { producedAssistantOutput: false, startedToolExecution: false }
    let softError: Error | undefined
    const unsubActivity = opts.skipEventSubscriptions ? () => {} : subscribeAttemptActivity(opts.session, activity)
    const unsubProvider = opts.skipEventSubscriptions
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
