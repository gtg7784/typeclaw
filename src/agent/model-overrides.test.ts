import { describe, expect, test } from 'bun:test'

import { resolveModel } from '@/config'
import type { KnownModelRef } from '@/config/providers'
import { KNOWN_PROVIDERS } from '@/config/providers'

import { applyModelRuntimeOverrides, effectiveBaseUrl } from './model-overrides'

const ANTHROPIC_REF = 'anthropic/claude-opus-4-8' as KnownModelRef
const OPENAI_REF = 'openai/gpt-5.4-nano' as KnownModelRef
const FIREWORKS_REF = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' as KnownModelRef

describe('applyModelRuntimeOverrides', () => {
  test('overrides anthropic baseUrl when ANTHROPIC_BASE_URL is set', () => {
    const model = resolveModel(ANTHROPIC_REF)
    const result = applyModelRuntimeOverrides(model, ANTHROPIC_REF, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    })
    expect(result.baseUrl).toBe('https://gateway.example.com')
  })

  test('overrides openai baseUrl when OPENAI_BASE_URL is set', () => {
    const model = resolveModel(OPENAI_REF)
    const result = applyModelRuntimeOverrides(model, OPENAI_REF, {
      OPENAI_BASE_URL: 'https://gateway.example.com/openai',
    })
    expect(result.baseUrl).toBe('https://gateway.example.com/openai')
  })

  test('leaves baseUrl untouched when the env var is unset', () => {
    const model = resolveModel(ANTHROPIC_REF)
    const result = applyModelRuntimeOverrides(model, ANTHROPIC_REF, {})
    expect(result.baseUrl).toBe(KNOWN_PROVIDERS.anthropic.baseUrl)
  })

  test('leaves openai baseUrl untouched when OPENAI_BASE_URL is unset', () => {
    const model = resolveModel(OPENAI_REF)
    const result = applyModelRuntimeOverrides(model, OPENAI_REF, {})
    expect(result.baseUrl).toBe(KNOWN_PROVIDERS.openai.baseUrl)
  })

  test('treats a blank value as unset', () => {
    const model = resolveModel(ANTHROPIC_REF)
    const result = applyModelRuntimeOverrides(model, ANTHROPIC_REF, { ANTHROPIC_BASE_URL: '   ' })
    expect(result.baseUrl).toBe(KNOWN_PROVIDERS.anthropic.baseUrl)
  })

  test('strips trailing slashes', () => {
    const model = resolveModel(ANTHROPIC_REF)
    const result = applyModelRuntimeOverrides(model, ANTHROPIC_REF, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic//',
    })
    expect(result.baseUrl).toBe('https://gateway.example.com/anthropic')
  })

  test('does not mutate the shared provider-table model literal', () => {
    const original = KNOWN_PROVIDERS.anthropic.models['claude-opus-4-8']!.baseUrl
    const model = resolveModel(ANTHROPIC_REF)
    applyModelRuntimeOverrides(model, ANTHROPIC_REF, { ANTHROPIC_BASE_URL: 'https://gateway.example.com' })
    expect(KNOWN_PROVIDERS.anthropic.models['claude-opus-4-8']!.baseUrl).toBe(original)
  })

  test('uses each provider its own env var, not the other provider', () => {
    const openaiModel = resolveModel(OPENAI_REF)
    const openaiResult = applyModelRuntimeOverrides(openaiModel, OPENAI_REF, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    })
    expect(openaiResult.baseUrl).toBe(KNOWN_PROVIDERS.openai.baseUrl)

    const anthropicModel = resolveModel(ANTHROPIC_REF)
    const anthropicResult = applyModelRuntimeOverrides(anthropicModel, ANTHROPIC_REF, {
      OPENAI_BASE_URL: 'https://gateway.example.com',
    })
    expect(anthropicResult.baseUrl).toBe(KNOWN_PROVIDERS.anthropic.baseUrl)
  })

  test('ignores the env vars for providers without an override', () => {
    const model = resolveModel(FIREWORKS_REF)
    const result = applyModelRuntimeOverrides(model, FIREWORKS_REF, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      OPENAI_BASE_URL: 'https://gateway.example.com',
    })
    expect(result.baseUrl).toBe(KNOWN_PROVIDERS.fireworks.baseUrl)
  })

  test('throws on a non-URL value', () => {
    const model = resolveModel(ANTHROPIC_REF)
    expect(() => applyModelRuntimeOverrides(model, ANTHROPIC_REF, { ANTHROPIC_BASE_URL: 'not a url' })).toThrow(
      /not a valid URL/,
    )
  })

  test('throws on a non-http(s) scheme', () => {
    const model = resolveModel(ANTHROPIC_REF)
    expect(() => applyModelRuntimeOverrides(model, ANTHROPIC_REF, { ANTHROPIC_BASE_URL: 'ftp://x.example' })).toThrow(
      /http:\/\/ or https:\/\//,
    )
  })

  test('names the offending env var in the error for openai', () => {
    const model = resolveModel(OPENAI_REF)
    expect(() => applyModelRuntimeOverrides(model, OPENAI_REF, { OPENAI_BASE_URL: 'not a url' })).toThrow(
      /OPENAI_BASE_URL is not a valid URL/,
    )
  })
})

describe('effectiveBaseUrl', () => {
  test('returns the override when set', () => {
    expect(
      effectiveBaseUrl('anthropic', 'https://api.anthropic.com', { ANTHROPIC_BASE_URL: 'https://proxy.example' }),
    ).toBe('https://proxy.example')
    expect(effectiveBaseUrl('openai', 'https://api.openai.com/v1', { OPENAI_BASE_URL: 'https://proxy.example' })).toBe(
      'https://proxy.example',
    )
  })

  test('returns the fallback when unset', () => {
    expect(effectiveBaseUrl('anthropic', 'https://api.anthropic.com', {})).toBe('https://api.anthropic.com')
    expect(effectiveBaseUrl('openai', 'https://api.openai.com/v1', {})).toBe('https://api.openai.com/v1')
  })

  test('returns undefined for a provider without an override', () => {
    expect(effectiveBaseUrl('fireworks', 'https://api.fireworks.ai/inference/v1', {})).toBeUndefined()
  })
})
