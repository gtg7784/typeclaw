import { describe, expect, test } from 'bun:test'

import {
  defaultThinkingLevelForRef,
  KNOWN_PROVIDERS,
  listKnownModelRefs,
  providerForModelRef,
  supportsApiKey,
  supportsOAuth,
} from './providers'

describe('KNOWN_PROVIDERS', () => {
  test('every provider model carries a baseUrl that matches the outer provider baseUrl', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        expect(model.baseUrl, `${providerId}/${modelId} baseUrl drift`).toBe(provider.baseUrl)
      }
    }
  })

  test('every model.provider field matches its outer provider id', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        expect(model.provider, `${providerId}/${modelId} provider drift`).toBe(providerId)
      }
    }
  })

  test('apiKeyEnv is set on every api-key-capable provider and null on oauth-only', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      if (supportsApiKey(provider)) {
        expect(provider.apiKeyEnv, `${providerId} missing apiKeyEnv`).not.toBeNull()
      } else {
        expect(provider.apiKeyEnv, `${providerId} oauth-only but has apiKeyEnv`).toBeNull()
      }
    }
  })

  test('oauthProviderId is set on every oauth-capable provider and null on api-key-only', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      if (supportsOAuth(provider)) {
        expect(provider.oauthProviderId, `${providerId} missing oauthProviderId`).not.toBeNull()
      } else {
        expect(provider.oauthProviderId, `${providerId} api-key-only but has oauthProviderId`).toBeNull()
      }
    }
  })

  test('zai (general API) is api-key only and uses the paygo endpoint', () => {
    const zai = KNOWN_PROVIDERS.zai
    expect(zai.baseUrl).toBe('https://api.z.ai/api/paas/v4')
    expect(zai.apiKeyEnv).toBe('ZAI_API_KEY')
    expect(supportsApiKey(zai)).toBe(true)
    expect(supportsOAuth(zai)).toBe(false)
  })

  test('zai-coding (Coding Plan) is api-key only and uses the coding endpoint', () => {
    const zaiCoding = KNOWN_PROVIDERS['zai-coding']
    expect(zaiCoding.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(zaiCoding.apiKeyEnv).toBe('ZAI_CODING_API_KEY')
    expect(supportsApiKey(zaiCoding)).toBe(true)
    expect(supportsOAuth(zaiCoding)).toBe(false)
  })

  test('zai and zai-coding use distinct env vars so users can hold both keys', () => {
    expect(KNOWN_PROVIDERS.zai.apiKeyEnv).not.toBe(KNOWN_PROVIDERS['zai-coding'].apiKeyEnv)
  })

  test('zai and zai-coding use distinct base URLs so paygo keys cannot accidentally hit the coding endpoint', () => {
    expect(KNOWN_PROVIDERS.zai.baseUrl).not.toBe(KNOWN_PROVIDERS['zai-coding'].baseUrl)
  })

  test('zai-coding only ships models the Coding Plan officially supports', () => {
    const codingPlanSupported = new Set(['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'])
    for (const modelId of Object.keys(KNOWN_PROVIDERS['zai-coding'].models)) {
      expect(codingPlanSupported.has(modelId), `${modelId} is not officially Coding-Plan-supported`).toBe(true)
    }
  })

  test('anthropic supports both api-key and oauth on the same provider id', () => {
    const anthropic = KNOWN_PROVIDERS.anthropic
    expect(anthropic.baseUrl).toBe('https://api.anthropic.com')
    expect(anthropic.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
    expect(anthropic.oauthProviderId).toBe('anthropic')
    expect(supportsApiKey(anthropic)).toBe(true)
    expect(supportsOAuth(anthropic)).toBe(true)
  })

  test('every anthropic model uses the anthropic-messages api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.anthropic.models)) {
      expect(model.api, `anthropic/${modelId} api drift`).toBe('anthropic-messages')
    }
  })
})

describe('providerForModelRef', () => {
  test('routes glm-5.1 to zai-coding (not zai)', () => {
    expect(providerForModelRef('zai-coding/glm-5.1')).toBe('zai-coding')
  })

  test('routes zai/glm-4.6 to zai (not zai-coding)', () => {
    expect(providerForModelRef('zai/glm-4.6')).toBe('zai')
  })

  test('distinguishes zai from zai-coding by the slash-prefixed match (not substring)', () => {
    expect(providerForModelRef('zai-coding/glm-5')).toBe('zai-coding')
    expect(providerForModelRef('zai/glm-4.6')).toBe('zai')
  })
})

describe('listKnownModelRefs', () => {
  test('includes both zai and zai-coding models', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('zai/glm-4.6')
    expect(refs).toContain('zai-coding/glm-5.1')
  })

  test('includes the current Anthropic GA tier (Haiku 4.5 / Sonnet 4.6 / Opus 4.7 / Opus 4.8)', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('anthropic/claude-haiku-4-5')
    expect(refs).toContain('anthropic/claude-sonnet-4-6')
    expect(refs).toContain('anthropic/claude-opus-4-7')
    expect(refs).toContain('anthropic/claude-opus-4-8')
  })
})

describe('providerForModelRef anthropic', () => {
  test('routes claude-sonnet-4-6 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-sonnet-4-6')).toBe('anthropic')
  })

  test('routes claude-opus-4-7 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-opus-4-7')).toBe('anthropic')
  })

  test('routes claude-opus-4-8 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-opus-4-8')).toBe('anthropic')
  })
})

describe('defaultThinkingLevelForRef', () => {
  test('OpenAI api-key models default to low', () => {
    expect(defaultThinkingLevelForRef('openai/gpt-5.4-nano')).toBe('low')
    expect(defaultThinkingLevelForRef('openai/gpt-5.4-mini')).toBe('low')
    expect(defaultThinkingLevelForRef('openai/gpt-5.4')).toBe('low')
    expect(defaultThinkingLevelForRef('openai/gpt-5.5')).toBe('low')
  })

  test('OpenAI Codex (ChatGPT Plus/Pro OAuth) models also default to low', () => {
    expect(defaultThinkingLevelForRef('openai-codex/gpt-5.4-mini')).toBe('low')
    expect(defaultThinkingLevelForRef('openai-codex/gpt-5.4')).toBe('low')
    expect(defaultThinkingLevelForRef('openai-codex/gpt-5.5')).toBe('low')
  })

  test('non-OpenAI providers defer to the SDK default (returns undefined)', () => {
    expect(defaultThinkingLevelForRef('anthropic/claude-opus-4-7')).toBeUndefined()
    expect(defaultThinkingLevelForRef('anthropic/claude-opus-4-8')).toBeUndefined()
    expect(defaultThinkingLevelForRef('anthropic/claude-sonnet-4-6')).toBeUndefined()
    expect(defaultThinkingLevelForRef('anthropic/claude-haiku-4-5')).toBeUndefined()
    expect(defaultThinkingLevelForRef('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')).toBeUndefined()
    expect(defaultThinkingLevelForRef('zai/glm-4.6')).toBeUndefined()
    expect(defaultThinkingLevelForRef('zai-coding/glm-5.1')).toBeUndefined()
  })

  test('every known model ref is classified (no provider falls through unhandled)', () => {
    for (const ref of listKnownModelRefs()) {
      const level = defaultThinkingLevelForRef(ref)
      expect(level === 'low' || level === undefined, `${ref} returned unexpected ${String(level)}`).toBe(true)
    }
  })
})
