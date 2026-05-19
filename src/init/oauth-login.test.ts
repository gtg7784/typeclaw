import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getOAuthProvider,
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from '@mariozechner/pi-ai/oauth'

import { makeFakeOAuthLoginRunner, makeOAuthLoginRunner, type OAuthCallbacks } from './oauth-login'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-oauth-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('makeFakeOAuthLoginRunner', () => {
  test('reports the chosen provider id back via onCalled', async () => {
    const calls: Array<{ providerId: string; cwd: string }> = []
    const runner = makeFakeOAuthLoginRunner({
      onCalled: ({ providerId, cwd }) => {
        calls.push({ providerId, cwd })
      },
    })

    const result = await runner({ cwd: root, model: 'openai-codex/gpt-5.5' })

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ providerId: 'openai-codex', cwd: root }])
  })

  test('passes through a configured failure result', async () => {
    const runner = makeFakeOAuthLoginRunner({ result: { ok: false, reason: 'simulated cancel' } })

    const result = await runner({ cwd: root, model: 'openai-codex/gpt-5.5' })

    expect(result).toEqual({ ok: false, reason: 'simulated cancel' })
  })
})

describe('makeOAuthLoginRunner', () => {
  test('rejects providers that do not support OAuth before touching the network', async () => {
    const callbacks: OAuthCallbacks = {
      onAuth: () => {
        throw new Error('onAuth should not have been called')
      },
      onPrompt: async () => {
        throw new Error('onPrompt should not have been called')
      },
    }
    const runner = makeOAuthLoginRunner(callbacks)

    const result = await runner({ cwd: root, model: 'openai/gpt-5.4-nano' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('does not support OAuth')
    }
  })

  // Swap pi-ai's real openai-codex OAuth provider for a capture-only fake so
  // we can assert what callback shape typeclaw hands to upstream — specifically
  // that onManualCodeInput is forwarded when supplied. Real bug this guards:
  // without this wiring, cross-device login (browser on a different machine
  // than the CLI) hangs forever because waitForCode never resolves and the
  // onPrompt fallback never fires either.
  describe('forwards onManualCodeInput to pi-ai when provided', () => {
    let original: OAuthProviderInterface | undefined
    let received: OAuthLoginCallbacks | undefined

    beforeEach(() => {
      received = undefined
      original = getOAuthProvider('openai-codex')
      registerOAuthProvider({
        id: 'openai-codex',
        name: 'fake openai-codex for tests',
        usesCallbackServer: true,
        login: async (callbacks) => {
          received = callbacks
          return { access: 'a', refresh: 'r', expires: Date.now() + 60_000 }
        },
        refreshToken: async () => {
          throw new Error('refresh not used in this test')
        },
        getApiKey: (c) => c.access,
      })
    })

    afterEach(() => {
      unregisterOAuthProvider('openai-codex')
      if (original) registerOAuthProvider(original)
    })

    test('onManualCodeInput is wired through and returns the value the CLI provides', async () => {
      const callbacks: OAuthCallbacks = {
        onAuth: () => {},
        onPrompt: async () => null,
        onManualCodeInput: async () => 'pasted-by-user',
      }
      const runner = makeOAuthLoginRunner(callbacks)

      const result = await runner({ cwd: root, model: 'openai-codex/gpt-5.5' })

      expect(result).toEqual({ ok: true })
      expect(received?.onManualCodeInput).toBeDefined()
      const value = await received?.onManualCodeInput?.()
      expect(value).toBe('pasted-by-user')
    })

    test('omitting onManualCodeInput leaves the upstream field unset (backwards compat)', async () => {
      const callbacks: OAuthCallbacks = {
        onAuth: () => {},
        onPrompt: async () => null,
      }
      const runner = makeOAuthLoginRunner(callbacks)

      const result = await runner({ cwd: root, model: 'openai-codex/gpt-5.5' })

      expect(result).toEqual({ ok: true })
      expect(received?.onManualCodeInput).toBeUndefined()
    })
  })
})
