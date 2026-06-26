import { describe, expect, test } from 'bun:test'

import { describeError } from '@/channels/adapters/describe-error'

describe('describeError', () => {
  test('returns the message of a plain Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  test('recovers the reason from an ErrorEvent-shaped object instead of [object ErrorEvent]', () => {
    // given: a browser/ws ErrorEvent is not an Error and stringifies uselessly
    const errorEvent = { type: 'error', message: 'Unexpected server response: 401' }
    expect(String(errorEvent)).toBe('[object Object]')

    expect(describeError(errorEvent)).toBe('Unexpected server response: 401')
  })

  test('digs into a nested .error when .message is absent', () => {
    const event = { type: 'error', error: new Error('ECONNREFUSED') }
    expect(describeError(event)).toBe('ECONNREFUSED')
  })

  test('joins AggregateError inner messages', () => {
    const agg = new AggregateError([new Error('a'), new Error('b')], 'all failed')
    expect(describeError(agg)).toBe('all failed: a; b')
  })

  test('unwraps an empty-message Error via its cause', () => {
    const err = new Error('')
    err.cause = new Error('root cause')
    expect(describeError(err)).toBe('root cause')
  })

  test('falls back to String() for primitives', () => {
    expect(describeError('plain string')).toBe('plain string')
    expect(describeError(42)).toBe('42')
  })

  test('does not loop on a self-referential object', () => {
    const circular: { error?: unknown; message?: unknown } = {}
    circular.error = circular
    expect(describeError(circular)).toBe(String(circular))
  })
})
