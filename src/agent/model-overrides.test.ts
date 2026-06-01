import { describe, expect, test } from 'bun:test'

import { resolveModel } from '@/config'
import type { KnownModelRef } from '@/config/providers'
import { KNOWN_PROVIDERS } from '@/config/providers'

import { applyModelRuntimeOverrides, effectiveAnthropicBaseUrl } from './model-overrides'

const ANTHROPIC_REF = 'anthropic/claude-opus-4-8' as KnownModelRef
const OPENAI_REF = 'openai/gpt-5.4-nano' as KnownModelRef

describe('applyModelRuntimeOverrides', () => {
  test('overrides anthropic baseUrl when ANTHROPIC_BASE_URL is set', () => {
    const model = resolveModel(ANTHROPIC_REF)
    const result = applyModelRuntimeOverrides(model, ANTHROPIC_REF, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    })
    expect(result.baseUrl).toBe('https://gateway.example.com')
  })

  test('leaves baseUrl untouched when the env var is unset', () => {
    const model = resolveModel(ANTHROPIC_REF)
    const result = applyModelRuntimeOverrides(model, ANTHROPIC_REF, {})
    expect(result.baseUrl).toBe(KNOWN_PROVIDERS.anthropic.baseUrl)
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

  test('ignores the env var for non-anthropic providers', () => {
    const model = resolveModel(OPENAI_REF)
    const result = applyModelRuntimeOverrides(model, OPENAI_REF, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    })
    expect(result.baseUrl).toBe(KNOWN_PROVIDERS.openai.baseUrl)
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
})

describe('effectiveAnthropicBaseUrl', () => {
  test('returns the override when set', () => {
    expect(
      effectiveAnthropicBaseUrl('https://api.anthropic.com', { ANTHROPIC_BASE_URL: 'https://proxy.example' }),
    ).toBe('https://proxy.example')
  })

  test('returns the fallback when unset', () => {
    expect(effectiveAnthropicBaseUrl('https://api.anthropic.com', {})).toBe('https://api.anthropic.com')
  })
})
