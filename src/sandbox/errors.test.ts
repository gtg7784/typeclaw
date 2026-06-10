import { describe, expect, test } from 'bun:test'

import {
  SandboxDegradedProcError,
  SandboxPolicyError,
  SandboxProcProbeUnverifiedError,
  SandboxUnavailableError,
} from './errors'

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

  test('tells the model that retrying is futile (this is the PERMANENT degrade)', () => {
    expect(new SandboxDegradedProcError().message.toLowerCase()).toContain('will not help')
  })

  test('is distinct from the other sandbox error types', () => {
    expect(new SandboxDegradedProcError()).not.toBeInstanceOf(SandboxPolicyError)
    expect(new SandboxDegradedProcError()).not.toBeInstanceOf(SandboxUnavailableError)
    expect(new SandboxDegradedProcError()).not.toBeInstanceOf(SandboxProcProbeUnverifiedError)
  })
})

describe('SandboxProcProbeUnverifiedError', () => {
  test('is an Error with a stable name so callers can branch on it', () => {
    const err = new SandboxProcProbeUnverifiedError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SandboxProcProbeUnverifiedError')
  })

  test('names the bun package commands and frames it as transient, not a command fault', () => {
    const { message } = new SandboxProcProbeUnverifiedError()
    expect(message).toContain('bun install')
    expect(message).toContain('bunx')
    expect(message.toLowerCase()).toContain('inconclusive')
    expect(message.toLowerCase()).toContain('temporary')
  })

  test('tells the model to retry the SAME command — the OPPOSITE of the permanent degrade', () => {
    // The whole point of the split: this transient error must NOT say "will not
    // help" (the permanent error's guidance), or the model gives up on a host
    // that recovers on the next re-probe. It must actively invite a retry.
    const { message } = new SandboxProcProbeUnverifiedError()
    expect(message.toLowerCase()).toContain('retry')
    expect(message.toLowerCase()).not.toContain('will not help')
  })

  test('is distinct from the other sandbox error types', () => {
    expect(new SandboxProcProbeUnverifiedError()).not.toBeInstanceOf(SandboxDegradedProcError)
    expect(new SandboxProcProbeUnverifiedError()).not.toBeInstanceOf(SandboxPolicyError)
    expect(new SandboxProcProbeUnverifiedError()).not.toBeInstanceOf(SandboxUnavailableError)
  })
})
