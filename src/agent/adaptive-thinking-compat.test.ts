import { describe, expect, test } from 'bun:test'

import type { Api, Model } from '@mariozechner/pi-ai'

import {
  applyAdaptiveThinkingCompat,
  isAdaptiveOnlyAnthropicModel,
  rewriteThinkingForAdaptiveOnlyModels,
} from './adaptive-thinking-compat'

function anthropicModel(id: string): Pick<Model<Api>, 'api' | 'id'> {
  return { api: 'anthropic-messages', id }
}

// The exact params shape pi-ai 0.67.3's budget-based branch produces for a
// reasoning Anthropic model that supportsAdaptiveThinking() does not match.
function budgetThinkingPayload(model: string) {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32000,
    stream: true,
    thinking: { type: 'enabled', budget_tokens: 4096 },
  }
}

describe('isAdaptiveOnlyAnthropicModel', () => {
  test('matches Sonnet 5 and Fable 5, with and without date suffix', () => {
    expect(isAdaptiveOnlyAnthropicModel(anthropicModel('claude-sonnet-5'))).toBe(true)
    expect(isAdaptiveOnlyAnthropicModel(anthropicModel('claude-fable-5'))).toBe(true)
    expect(isAdaptiveOnlyAnthropicModel(anthropicModel('claude-sonnet-5-20260701'))).toBe(true)
    expect(isAdaptiveOnlyAnthropicModel(anthropicModel('claude-fable-5-20260615'))).toBe(true)
  })

  test('does not match other Anthropic models', () => {
    expect(isAdaptiveOnlyAnthropicModel(anthropicModel('claude-sonnet-4-6'))).toBe(false)
    expect(isAdaptiveOnlyAnthropicModel(anthropicModel('claude-opus-4-8'))).toBe(false)
    expect(isAdaptiveOnlyAnthropicModel(anthropicModel('claude-opus-4-5'))).toBe(false)
    expect(isAdaptiveOnlyAnthropicModel(anthropicModel('claude-haiku-4-5'))).toBe(false)
  })

  test('does not match same-named ids on a non-anthropic-messages transport', () => {
    expect(isAdaptiveOnlyAnthropicModel({ api: 'openai-completions', id: 'claude-sonnet-5' })).toBe(false)
  })
})

describe('rewriteThinkingForAdaptiveOnlyModels', () => {
  test('rewrites budget thinking to adaptive for Sonnet 5 — budget_tokens never leaves', () => {
    const result = rewriteThinkingForAdaptiveOnlyModels(
      budgetThinkingPayload('claude-sonnet-5'),
      anthropicModel('claude-sonnet-5'),
    )
    expect(result).toMatchObject({ thinking: { type: 'adaptive' } })
    expect(JSON.stringify(result)).not.toContain('budget_tokens')
  })

  test('rewrites budget thinking to adaptive for Fable 5 — budget_tokens never leaves', () => {
    const result = rewriteThinkingForAdaptiveOnlyModels(
      budgetThinkingPayload('claude-fable-5'),
      anthropicModel('claude-fable-5'),
    )
    expect(result).toMatchObject({ thinking: { type: 'adaptive' } })
    expect(JSON.stringify(result)).not.toContain('budget_tokens')
  })

  test('preserves all sibling params when rewriting', () => {
    const payload = budgetThinkingPayload('claude-sonnet-5')
    const result = rewriteThinkingForAdaptiveOnlyModels(payload, anthropicModel('claude-sonnet-5'))
    expect(result).toMatchObject({
      model: 'claude-sonnet-5',
      messages: payload.messages,
      max_tokens: 32000,
      stream: true,
    })
  })

  test('does not mutate the incoming payload object', () => {
    const payload = budgetThinkingPayload('claude-sonnet-5')
    rewriteThinkingForAdaptiveOnlyModels(payload, anthropicModel('claude-sonnet-5'))
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
  })

  test('returns the payload untouched (same reference) for budget-thinking models', () => {
    const payload = budgetThinkingPayload('claude-opus-4-5')
    expect(rewriteThinkingForAdaptiveOnlyModels(payload, anthropicModel('claude-opus-4-5'))).toBe(payload)
  })

  test('returns the payload untouched for adaptive 4.6 models pi-ai already handles', () => {
    const payload = { model: 'claude-sonnet-4-6', thinking: { type: 'adaptive' } }
    expect(rewriteThinkingForAdaptiveOnlyModels(payload, anthropicModel('claude-sonnet-4-6'))).toBe(payload)
  })

  test('leaves thinking: disabled untouched on target models', () => {
    const payload = { model: 'claude-sonnet-5', thinking: { type: 'disabled' } }
    expect(rewriteThinkingForAdaptiveOnlyModels(payload, anthropicModel('claude-sonnet-5'))).toBe(payload)
  })

  test('leaves payloads without a thinking param untouched on target models', () => {
    const payload = { model: 'claude-fable-5', messages: [] }
    expect(rewriteThinkingForAdaptiveOnlyModels(payload, anthropicModel('claude-fable-5'))).toBe(payload)
  })

  test('tolerates non-object payloads', () => {
    expect(rewriteThinkingForAdaptiveOnlyModels(undefined, anthropicModel('claude-sonnet-5'))).toBeUndefined()
    expect(rewriteThinkingForAdaptiveOnlyModels(null, anthropicModel('claude-sonnet-5'))).toBeNull()
    expect(rewriteThinkingForAdaptiveOnlyModels('x', anthropicModel('claude-sonnet-5'))).toBe('x')
  })
})

type FakeAgent = {
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>
}

function asModel(id: string): Model<Api> {
  return anthropicModel(id) as Model<Api>
}

describe('applyAdaptiveThinkingCompat', () => {
  test('rewrites when the agent has no inner onPayload', async () => {
    const agent: FakeAgent = {}
    applyAdaptiveThinkingCompat(agent)
    const result = await agent.onPayload?.(budgetThinkingPayload('claude-sonnet-5'), asModel('claude-sonnet-5'))
    expect(result).toMatchObject({ thinking: { type: 'adaptive' } })
  })

  test('runs the inner hook first and rewrites its output', async () => {
    const seen: unknown[] = []
    const agent: FakeAgent = {
      onPayload: async (payload) => {
        seen.push(payload)
        return { ...(payload as object), tagged: true }
      },
    }
    applyAdaptiveThinkingCompat(agent)
    const original = budgetThinkingPayload('claude-sonnet-5')
    const result = await agent.onPayload?.(original, asModel('claude-sonnet-5'))
    expect(seen).toEqual([original])
    expect(result).toMatchObject({ tagged: true, thinking: { type: 'adaptive' } })
  })

  test("honors pi's contract: inner undefined falls back to the original payload", async () => {
    const agent: FakeAgent = { onPayload: async () => undefined }
    applyAdaptiveThinkingCompat(agent)
    const result = await agent.onPayload?.(budgetThinkingPayload('claude-fable-5'), asModel('claude-fable-5'))
    expect(result).toMatchObject({ thinking: { type: 'adaptive' } })
  })

  test('passes non-target models through the inner hook unchanged', async () => {
    const agent: FakeAgent = {}
    applyAdaptiveThinkingCompat(agent)
    const payload = budgetThinkingPayload('claude-opus-4-5')
    const result = await agent.onPayload?.(payload, asModel('claude-opus-4-5'))
    expect(result).toBe(payload)
  })
})
