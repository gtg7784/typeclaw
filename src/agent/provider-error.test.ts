import { describe, expect, test } from 'bun:test'

import type { AgentSession } from './index'
import { detectProviderError, subscribeProviderErrors } from './provider-error'

describe('detectProviderError', () => {
  test('returns the errorMessage for assistant message with stopReason=error', () => {
    const result = detectProviderError({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Your account is not active, please check your billing details on our website.',
    })

    expect(result).toEqual({
      message: 'Your account is not active, please check your billing details on our website.',
    })
  })

  test('falls back to a generic message when stopReason=error has no errorMessage', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'error' })

    expect(result).toEqual({ message: 'LLM call failed' })
  })

  test('falls back to a generic message when errorMessage is an empty string', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: '' })

    expect(result).toEqual({ message: 'LLM call failed' })
  })

  test('returns null for stopReason=aborted (user-initiated, not a provider failure)', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'aborted', errorMessage: 'cancelled' })

    expect(result).toBeNull()
  })

  test('returns null for stopReason=stop (normal completion)', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'stop' })

    expect(result).toBeNull()
  })

  test('returns null for non-assistant roles (user/toolResult)', () => {
    expect(detectProviderError({ role: 'user', stopReason: 'error' })).toBeNull()
    expect(detectProviderError({ role: 'toolResult', stopReason: 'error' })).toBeNull()
  })

  test('returns null for null, undefined, primitives, or arrays', () => {
    expect(detectProviderError(null)).toBeNull()
    expect(detectProviderError(undefined)).toBeNull()
    expect(detectProviderError('string')).toBeNull()
    expect(detectProviderError(42)).toBeNull()
    expect(detectProviderError([])).toBeNull()
  })

  test('returns null when errorMessage is present but stopReason is something other than error', () => {
    const result = detectProviderError({
      role: 'assistant',
      stopReason: 'tool_calls',
      errorMessage: 'should not surface',
    })

    expect(result).toBeNull()
  })
})

type FakeListener = (event: { type: string; message?: unknown }) => void

function fakeSession(): { session: AgentSession; emit: (event: { type: string; message?: unknown }) => void } {
  const listeners = new Set<FakeListener>()
  const session = {
    subscribe: (cb: FakeListener) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  } as unknown as AgentSession
  return {
    session,
    emit: (event) => {
      for (const cb of listeners) cb(event)
    },
  }
}

describe('subscribeProviderErrors', () => {
  test('invokes onError exactly once per detected provider error', () => {
    const { session, emit } = fakeSession()
    const calls: string[] = []
    subscribeProviderErrors(session, (err) => calls.push(err.message))

    emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limited' },
    })
    emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'billing fail' },
    })

    expect(calls).toEqual(['rate limited', 'billing fail'])
  })

  test('ignores non-message_end events even if they carry an error-looking payload', () => {
    const { session, emit } = fakeSession()
    const calls: string[] = []
    subscribeProviderErrors(session, (err) => calls.push(err.message))

    emit({ type: 'message_update', message: { role: 'assistant', stopReason: 'error' } })
    emit({ type: 'tool_execution_start', message: { role: 'assistant', stopReason: 'error' } })

    expect(calls).toEqual([])
  })

  test('ignores message_end events with stopReason=stop / aborted / non-assistant roles', () => {
    const { session, emit } = fakeSession()
    const calls: string[] = []
    subscribeProviderErrors(session, (err) => calls.push(err.message))

    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } })
    emit({ type: 'message_end', message: { role: 'user', stopReason: 'error' } })

    expect(calls).toEqual([])
  })

  test('returns an unsubscribe handle that detaches the listener', () => {
    const { session, emit } = fakeSession()
    const calls: string[] = []
    const unsub = subscribeProviderErrors(session, (err) => calls.push(err.message))

    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'first' } })
    unsub()
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'second' } })

    expect(calls).toEqual(['first'])
  })
})
