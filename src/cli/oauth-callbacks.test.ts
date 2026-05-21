import { describe, expect, test } from 'bun:test'

import { buildOAuthCallbacks } from './oauth-callbacks'

describe('buildOAuthCallbacks', () => {
  test('provides every callback the OAuth runner forwards to pi-ai, including onManualCodeInput', () => {
    const { callbacks } = buildOAuthCallbacks('Test Provider')

    expect(typeof callbacks.onAuth).toBe('function')
    expect(typeof callbacks.onProgress).toBe('function')
    expect(typeof callbacks.onPrompt).toBe('function')
    expect(typeof callbacks.onManualCodeInput).toBe('function')
  })

  test('returns a dispose function so call sites can cancel orphaned prompts after pi-ai wins the browser race', () => {
    const { dispose } = buildOAuthCallbacks('Test Provider')

    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
  })
})
