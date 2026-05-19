import { describe, expect, test } from 'bun:test'

import { buildOAuthCallbacks } from './oauth-callbacks'

describe('buildOAuthCallbacks', () => {
  test('provides every callback the OAuth runner forwards to pi-ai, including onManualCodeInput', () => {
    const callbacks = buildOAuthCallbacks('Test Provider')

    expect(typeof callbacks.onAuth).toBe('function')
    expect(typeof callbacks.onProgress).toBe('function')
    expect(typeof callbacks.onPrompt).toBe('function')
    expect(typeof callbacks.onManualCodeInput).toBe('function')
  })
})
