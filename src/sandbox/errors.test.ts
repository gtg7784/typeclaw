import { describe, expect, test } from 'bun:test'

import { SandboxDegradedProcError, SandboxPolicyError, SandboxUnavailableError } from './errors'

describe('SandboxDegradedProcError', () => {
  test('is an Error with a stable name so callers can branch on it', () => {
    const err = new SandboxDegradedProcError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SandboxDegradedProcError')
  })

  test('names the bun package commands and frames it as an environment limit, not a command fault', () => {
    const { message } = new SandboxDegradedProcError()
    expect(message).toContain('bun install')
    expect(message).toContain('bunx')
    expect(message).toContain('NotDir')
    expect(message.toLowerCase()).toContain('retry')
  })

  test('is distinct from the other sandbox error types', () => {
    expect(new SandboxDegradedProcError()).not.toBeInstanceOf(SandboxPolicyError)
    expect(new SandboxDegradedProcError()).not.toBeInstanceOf(SandboxUnavailableError)
  })
})
