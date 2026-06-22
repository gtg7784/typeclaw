import { describe, expect, test } from 'bun:test'

import {
  defaultThinkingLevelForRef,
  isKnownModelRef,
  isOpenAiFamilyRef,
  isModelRef,
  KNOWN_PROVIDER_VENDORS,
  KNOWN_PROVIDERS,
  type KnownProviderId,
  listKnownModelRefs,
  listKnownProviderVendorIds,
  providerForModelRef,
  providerIdsForVendor,
  supportsApiKey,
  supportsOAuth,
  variantLabel,
  vendorForProviderId,
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

  test('minimax is a single api-key provider serving both paygo and Token Plan keys', () => {
    const minimax = KNOWN_PROVIDERS.minimax
    expect(minimax.baseUrl).toBe('https://api.minimax.io/v1')
    expect(minimax.apiKeyEnv).toBe('MINIMAX_API_KEY')
    expect(supportsApiKey(minimax)).toBe(true)
    expect(supportsOAuth(minimax)).toBe(false)
  })

  test('every minimax model uses the openai-completions api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.minimax.models)) {
      expect(model.api, `minimax/${modelId} api drift`).toBe('openai-completions')
    }
  })

  test('minimax ships the M3 flagship plus the M2 series', () => {
    const modelIds = Object.keys(KNOWN_PROVIDERS.minimax.models)
    expect(modelIds).toContain('MiniMax-M3')
    expect(modelIds).toContain('MiniMax-M2')
    expect(modelIds).toContain('MiniMax-M2.5')
  })

  test('only MiniMax-M3 accepts image input; the M2 series is text-only', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.minimax.models)) {
      const expectsImage = modelId === 'MiniMax-M3'
      expect((model.input as ReadonlyArray<string>).includes('image'), `minimax/${modelId} vision drift`).toBe(
        expectsImage,
      )
    }
  })

  test('minimax cache rates match the published pay-as-you-go pricing table', () => {
    // ≤512K standard tier from docs/guides/pricing-paygo; M3 has no cache-write rate.
    const expectedCache: Record<string, { cacheRead: number; cacheWrite: number }> = {
      'MiniMax-M3': { cacheRead: 0.06, cacheWrite: 0 },
      'MiniMax-M2.7': { cacheRead: 0.06, cacheWrite: 0.375 },
      'MiniMax-M2.5': { cacheRead: 0.03, cacheWrite: 0.375 },
      'MiniMax-M2.1': { cacheRead: 0.03, cacheWrite: 0.375 },
      'MiniMax-M2': { cacheRead: 0.03, cacheWrite: 0.375 },
    }
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.minimax.models)) {
      const cost = model.cost as { cacheRead: number; cacheWrite: number }
      expect(cost.cacheRead, `minimax/${modelId} cacheRead drift`).toBe(expectedCache[modelId]!.cacheRead)
      expect(cost.cacheWrite, `minimax/${modelId} cacheWrite drift`).toBe(expectedCache[modelId]!.cacheWrite)
    }
  })

  test('deepseek is a single api-key provider on the bare api.deepseek.com base url', () => {
    const deepseek = KNOWN_PROVIDERS.deepseek
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com')
    expect(deepseek.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(supportsApiKey(deepseek)).toBe(true)
    expect(supportsOAuth(deepseek)).toBe(false)
  })

  test('every deepseek model uses the openai-completions api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.deepseek.models)) {
      expect(model.api, `deepseek/${modelId} api drift`).toBe('openai-completions')
    }
  })

  test('deepseek ships the V4 flash and pro models, text-only', () => {
    const models = KNOWN_PROVIDERS.deepseek.models
    expect(Object.keys(models)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    for (const [modelId, model] of Object.entries(models)) {
      expect((model.input as ReadonlyArray<string>).includes('image'), `deepseek/${modelId} should be text-only`).toBe(
        false,
      )
    }
  })

  test('deepseek input cost encodes the cache-miss rate and cacheRead the cache-hit rate', () => {
    const expected: Record<string, { input: number; output: number; cacheRead: number }> = {
      'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
      'deepseek-v4-pro': { input: 0.435, output: 0.87, cacheRead: 0.003625 },
    }
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.deepseek.models)) {
      const cost = model.cost as { input: number; output: number; cacheRead: number; cacheWrite: number }
      expect(cost.input, `deepseek/${modelId} input drift`).toBe(expected[modelId]!.input)
      expect(cost.output, `deepseek/${modelId} output drift`).toBe(expected[modelId]!.output)
      expect(cost.cacheRead, `deepseek/${modelId} cacheRead drift`).toBe(expected[modelId]!.cacheRead)
      expect(cost.cacheWrite, `deepseek/${modelId} has no published cache-write surcharge`).toBe(0)
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

  test('moonshot (Open Platform paygo) is api-key only on the OpenAI-compatible endpoint', () => {
    const moonshot = KNOWN_PROVIDERS.moonshot
    expect(moonshot.baseUrl).toBe('https://api.moonshot.ai/v1')
    expect(moonshot.apiKeyEnv).toBe('MOONSHOT_API_KEY')
    expect(supportsApiKey(moonshot)).toBe(true)
    expect(supportsOAuth(moonshot)).toBe(false)
  })

  test('moonshot-coding (Kimi Code subscription) is api-key only on the Kimi Code endpoint', () => {
    const coding = KNOWN_PROVIDERS['moonshot-coding']
    expect(coding.baseUrl).toBe('https://api.kimi.com/coding/v1')
    expect(coding.apiKeyEnv).toBe('MOONSHOT_CODING_API_KEY')
    expect(supportsApiKey(coding)).toBe(true)
    expect(supportsOAuth(coding)).toBe(false)
  })

  test('moonshot and moonshot-coding use distinct env vars so users can hold both keys', () => {
    expect(KNOWN_PROVIDERS.moonshot.apiKeyEnv).not.toBe(KNOWN_PROVIDERS['moonshot-coding'].apiKeyEnv)
  })

  test('moonshot and moonshot-coding use distinct base URLs so paygo keys cannot hit the coding endpoint', () => {
    expect(KNOWN_PROVIDERS.moonshot.baseUrl).not.toBe(KNOWN_PROVIDERS['moonshot-coding'].baseUrl)
  })

  test('every moonshot model uses the openai-completions api so pi-ai routes correctly', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.moonshot.models)) {
      expect(model.api, `moonshot/${modelId} api drift`).toBe('openai-completions')
    }
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS['moonshot-coding'].models)) {
      expect(model.api, `moonshot-coding/${modelId} api drift`).toBe('openai-completions')
    }
  })

  test('moonshot ships the current multimodal K2 generation (deprecated k2 series omitted)', () => {
    const modelIds = Object.keys(KNOWN_PROVIDERS.moonshot.models)
    expect(modelIds).toEqual(['kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5'])
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.moonshot.models)) {
      expect((model.input as ReadonlyArray<string>).includes('image'), `moonshot/${modelId} vision drift`).toBe(true)
    }
  })

  test('moonshot omits the kimi-k2 series discontinued on 2026-05-25', () => {
    const modelIds = Object.keys(KNOWN_PROVIDERS.moonshot.models)
    expect(modelIds).not.toContain('kimi-k2-thinking')
    expect(modelIds).not.toContain('kimi-k2-0905-preview')
    expect(modelIds).not.toContain('kimi-k2-turbo-preview')
  })

  test('moonshot-coding ships only the kimi-for-coding alias billed at zero per-token', () => {
    const models = KNOWN_PROVIDERS['moonshot-coding'].models
    expect(Object.keys(models)).toEqual(['kimi-for-coding'])
    const cost = models['kimi-for-coding']!.cost as { input: number; output: number }
    expect(cost.input).toBe(0)
    expect(cost.output).toBe(0)
  })

  test('xai supports both api-key and oauth against the native x.ai endpoint', () => {
    const xai = KNOWN_PROVIDERS.xai
    expect(xai.baseUrl).toBe('https://api.x.ai/v1')
    expect(xai.apiKeyEnv).toBe('XAI_API_KEY')
    expect(xai.oauthProviderId).toBe('xai')
    expect(supportsApiKey(xai)).toBe(true)
    expect(supportsOAuth(xai)).toBe(true)
  })

  test('every xai model uses the openai-completions api (x.ai is OpenAI-compatible)', () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.xai.models)) {
      expect(model.api, `xai/${modelId} api drift`).toBe('openai-completions')
    }
  })
})

describe('KNOWN_PROVIDER_VENDORS', () => {
  test('every vendor references only known provider ids', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        expect(providerId in KNOWN_PROVIDERS, `${vendorId} references unknown provider ${providerId}`).toBe(true)
      }
    }
  })

  test('every known provider belongs to exactly one vendor (full partition)', () => {
    const assigned = new Map<KnownProviderId, number>()
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        assigned.set(providerId, (assigned.get(providerId) ?? 0) + 1)
      }
    }
    for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
      expect(assigned.get(providerId), `${providerId} not assigned to exactly one vendor`).toBe(1)
    }
  })

  test('vendorForProviderId is the inverse of providerIdsForVendor', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        expect(vendorForProviderId(providerId)).toBe(vendorId)
      }
    }
  })

  test('multi-provider vendors supply variant copy for each of their providers', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      const providers = providerIdsForVendor(vendorId)
      if (providers.length < 2) continue
      for (const providerId of providers) {
        expect(variantLabel(vendorId, providerId), `${vendorId}/${providerId} missing variant label`).not.toBe(
          KNOWN_PROVIDERS[providerId].name,
        )
      }
    }
  })

  test('OpenAI vendor splits API key (openai) from ChatGPT OAuth (openai-codex)', () => {
    expect(providerIdsForVendor('openai')).toEqual(['openai', 'openai-codex'])
    expect(variantLabel('openai', 'openai')).toBe('API key')
    expect(variantLabel('openai', 'openai-codex')).toBe('OAuth (ChatGPT Plus/Pro)')
  })

  test('Z.AI vendor splits paygo (zai) from Coding Plan (zai-coding)', () => {
    expect(providerIdsForVendor('zai')).toEqual(['zai', 'zai-coding'])
    expect(variantLabel('zai', 'zai')).toBe('Pay-as-you-go')
    expect(variantLabel('zai', 'zai-coding')).toBe('Coding Plan')
  })

  test('Anthropic, Fireworks, and xAI are single-provider vendors (no variant step)', () => {
    expect(providerIdsForVendor('anthropic')).toEqual(['anthropic'])
    expect(providerIdsForVendor('fireworks')).toEqual(['fireworks'])
    expect(providerIdsForVendor('xai')).toEqual(['xai'])
  })

  test('xAI vendor resolves to the single dual-auth xai provider', () => {
    expect(vendorForProviderId('xai')).toBe('xai')
    expect(KNOWN_PROVIDER_VENDORS.xai.name).toBe('xAI (Grok)')
  })

  test('MiniMax is a single-provider vendor: paygo and Token Plan share one provider id', () => {
    expect(providerIdsForVendor('minimax')).toEqual(['minimax'])
    expect(vendorForProviderId('minimax')).toBe('minimax')
  })

  test('DeepSeek is a single-provider vendor (no variant step)', () => {
    expect(providerIdsForVendor('deepseek')).toEqual(['deepseek'])
    expect(vendorForProviderId('deepseek')).toBe('deepseek')
  })

  test('Moonshot vendor splits paygo (moonshot) from Coding Plan (moonshot-coding)', () => {
    expect(providerIdsForVendor('moonshot')).toEqual(['moonshot', 'moonshot-coding'])
    expect(variantLabel('moonshot', 'moonshot')).toBe('Pay-as-you-go')
    expect(variantLabel('moonshot', 'moonshot-coding')).toBe('Coding Plan')
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

  test('distinguishes moonshot from moonshot-coding by the slash-prefixed match (not substring)', () => {
    expect(providerForModelRef('moonshot-coding/kimi-for-coding')).toBe('moonshot-coding')
    expect(providerForModelRef('moonshot/kimi-k2.6')).toBe('moonshot')
  })
})

describe('model ref predicates', () => {
  test('isKnownModelRef accepts curated refs only', () => {
    expect(isKnownModelRef('openai/gpt-5.4-nano')).toBe(true)
    expect(isKnownModelRef('openai/gpt-6-live')).toBe(false)
  })

  test('isModelRef accepts custom refs for known providers', () => {
    expect(isModelRef('openai/gpt-6-live')).toBe(true)
    expect(isModelRef('fireworks/accounts/fireworks/models/qwen3-next')).toBe(true)
  })

  test('isModelRef rejects unknown providers and malformed refs', () => {
    expect(isModelRef('unknown/gpt-6-live')).toBe(false)
    expect(isModelRef('openai/')).toBe(false)
    expect(isModelRef('OpenAI/gpt-6-live')).toBe(false)
    expect(isModelRef('openai/gpt 6')).toBe(false)
  })
})

describe('listKnownModelRefs', () => {
  test('includes both zai and zai-coding models', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('zai/glm-4.6')
    expect(refs).toContain('zai-coding/glm-5.1')
  })

  test('includes minimax model refs', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('minimax/MiniMax-M3')
    expect(refs).toContain('minimax/MiniMax-M2')
  })

  test('includes deepseek model refs', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('deepseek/deepseek-v4-flash')
    expect(refs).toContain('deepseek/deepseek-v4-pro')
  })

  test('includes both moonshot and moonshot-coding model refs', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('moonshot/kimi-k2.7-code')
    expect(refs).toContain('moonshot/kimi-k2.5')
    expect(refs).toContain('moonshot-coding/kimi-for-coding')
  })

  test('includes the current Anthropic GA tier (Haiku 4.5 / Sonnet 4.6 / Opus 4.7 / Opus 4.8)', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('anthropic/claude-haiku-4-5')
    expect(refs).toContain('anthropic/claude-sonnet-4-6')
    expect(refs).toContain('anthropic/claude-opus-4-7')
    expect(refs).toContain('anthropic/claude-opus-4-8')
  })

  test('includes the current xai Grok models', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('xai/grok-4.3')
    expect(refs).toContain('xai/grok-4.20-0309-reasoning')
    expect(refs).toContain('xai/grok-4.20-0309-non-reasoning')
    expect(refs).toContain('xai/grok-build-0.1')
  })

  test('does not list xai models retired on 2026-05-15', () => {
    const refs = listKnownModelRefs()
    expect(refs).not.toContain('xai/grok-4-fast')
    expect(refs).not.toContain('xai/grok-4')
    expect(refs).not.toContain('xai/grok-code-fast-1')
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

describe('isOpenAiFamilyRef', () => {
  test('tracks every provider in the OpenAI vendor family', () => {
    expect(isOpenAiFamilyRef('openai/gpt-5.4-nano')).toBe(true)
    expect(isOpenAiFamilyRef('openai-codex/gpt-5.5')).toBe(true)
    expect(isOpenAiFamilyRef('anthropic/claude-opus-4-7')).toBe(false)
  })
})

describe('defaultThinkingLevelForRef', () => {
  test('OpenAI-family models no longer pin low; they defer to the SDK default', () => {
    expect(defaultThinkingLevelForRef('openai/gpt-5.4-nano')).toBeUndefined()
    expect(defaultThinkingLevelForRef('openai/gpt-5.5')).toBeUndefined()
    expect(defaultThinkingLevelForRef('openai-codex/gpt-5.4')).toBeUndefined()
    expect(defaultThinkingLevelForRef('openai-codex/gpt-5.5')).toBeUndefined()
  })

  test('non-OpenAI providers defer to the SDK default (returns undefined)', () => {
    expect(defaultThinkingLevelForRef('anthropic/claude-opus-4-8')).toBeUndefined()
    expect(defaultThinkingLevelForRef('zai/glm-4.6')).toBeUndefined()
    expect(defaultThinkingLevelForRef('moonshot/kimi-k2.5')).toBeUndefined()
  })

  test('every known model ref defers to the SDK default (no family is pinned)', () => {
    for (const ref of listKnownModelRefs()) {
      expect(defaultThinkingLevelForRef(ref), `${ref} should defer to the SDK default`).toBeUndefined()
    }
  })
})
