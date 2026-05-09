import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
})
