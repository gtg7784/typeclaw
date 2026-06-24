import type { ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { subscribeProviderErrors } from './provider-error'

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
  beforeAttempt?: (ref: ModelRef) => void
  onAttemptFailed?: (attempt: PersistentTurnAttempt) => void
}): Promise<PersistentTurnResult> {
  if (opts.refs.length === 0) throw new Error('promptPersistentTurnWithFallback: refs[] must be non-empty')
  const start = Math.max(0, opts.refs.indexOf(opts.currentRef))
  const attempts: PersistentTurnAttempt[] = []
  let lastError: Error | undefined
  for (let i = start; i < opts.refs.length; i++) {
    const ref = opts.refs[i]!
    const isLast = i === opts.refs.length - 1
    if (i !== start) await opts.setModelForRef(ref)
    opts.beforeAttempt?.(ref)
    const activity: AttemptActivity = { producedAssistantOutput: false, startedToolExecution: false }
    let softError: Error | undefined
    const unsubActivity = subscribeAttemptActivity(opts.session, activity)
    const unsubProvider = subscribeProviderErrors(opts.session, (err) => {
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
        if (isLast || !canAdvance(error, activity, opts.shouldFailover)) throw error
        opts.onAttemptFailed?.(attempt)
        continue
      }
      if (softError !== undefined) {
        const attempt: PersistentTurnAttempt = { ref, outcome: 'soft', errorMessage: softError.message }
        attempts.push(attempt)
        lastError = softError
        if (isLast || !canAdvance(softError, activity, opts.shouldFailover)) {
          return { success: false, refUsed: ref, attempts, lastError }
        }
        opts.onAttemptFailed?.(attempt)
        continue
      }
      attempts.push({ ref, outcome: 'success' })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
