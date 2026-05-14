import { describe, expect, test } from 'bun:test'

import { KNOWN_PROVIDERS } from '@/config/providers'

import { decideExistingApiKeyReuse } from './init'

describe('decideExistingApiKeyReuse', () => {
  test('reuses an existing API key when the user confirms', async () => {
    const messages: string[] = []

    const decision = await decideExistingApiKeyReuse(KNOWN_PROVIDERS.openai, 'openai-existing-key', async (message) => {
      messages.push(message)
      return true
    })

    expect(decision).toBe('reuse')
    expect(messages).toEqual(['Reuse existing OpenAI API key from secrets.json?'])
  })

  test('prompts for a new API key when the user declines reuse', async () => {
    const decision = await decideExistingApiKeyReuse(KNOWN_PROVIDERS.fireworks, 'fw_existing', async () => false)

    expect(decision).toBe('prompt')
  })

  test('skips the reuse question when there is no existing API key', async () => {
    let asked = false

    const decision = await decideExistingApiKeyReuse(KNOWN_PROVIDERS.openai, null, async () => {
      asked = true
      return true
    })

    expect(decision).toBe('prompt')
    expect(asked).toBe(false)
  })

  test('skips the reuse question for OAuth-only providers', async () => {
    let asked = false

    const decision = await decideExistingApiKeyReuse(KNOWN_PROVIDERS['openai-codex'], 'unused-key', async () => {
      asked = true
      return true
    })

    expect(decision).toBe('prompt')
    expect(asked).toBe(false)
  })
})
