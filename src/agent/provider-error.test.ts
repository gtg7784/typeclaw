import { describe, expect, test } from 'bun:test'

import type { AgentSession } from './index'
import { detectProviderError, subscribeProviderErrors } from './provider-error'

describe('detectProviderError', () => {
  test('preserves the raw errorMessage on `message` for operator surfaces (logs/TUI)', () => {
    const result = detectProviderError({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Your account is not active, please check your billing details on our website.',
    })

    expect(result?.message).toBe('Your account is not active, please check your billing details on our website.')
  })

  test('falls back to a generic raw message when stopReason=error has no errorMessage', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'error' })

    expect(result?.message).toBe('LLM call failed')
  })

  test('falls back to a generic raw message when errorMessage is an empty string', () => {
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: '' })

    expect(result?.message).toBe('LLM call failed')
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

describe('detectProviderError safeMessage redaction', () => {
  test('maps rate/usage-limit errors to a canonical channel-safe sentence', () => {
    const raw = 'You have hit your ChatGPT usage limit (team plan). Try again in ~40 min.'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toMatch(/rate-limited/i)
    expect(result?.safeMessage).not.toContain('team plan')
  })

  test('maps billing/quota errors to a billing-safe sentence without echoing the raw text', () => {
    const raw =
      'Your account is not active, please check your billing details on our website https://x.test/acct/secret-123.'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toMatch(/billing\/quota/i)
    expect(result?.safeMessage).not.toContain('secret-123')
    expect(result?.safeMessage).not.toContain('https://')
  })

  test('collapses unknown / malformed-response failures to a generic notice (no raw leak)', () => {
    const raw = 'malformed response: {"id":"resp_abc","debug":"Bearer sk-live-LEAK","body":"<html>500</html>"}'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.safeMessage).toBe(
      'The upstream LLM provider failed. Operators can check `typeclaw logs` for details.',
    )
    expect(result?.safeMessage).not.toContain('sk-live-LEAK')
    expect(result?.safeMessage).not.toContain('resp_abc')
  })

  test('still exposes the raw text on `message` even when `safeMessage` is redacted', () => {
    const raw = 'malformed response: Bearer sk-live-LEAK'
    const result = detectProviderError({ role: 'assistant', stopReason: 'error', errorMessage: raw })

    expect(result?.message).toBe(raw)
    expect(result?.safeMessage).not.toBe(raw)
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
