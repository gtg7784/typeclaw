import { describe, expect, test } from 'bun:test'

import { curatedOptions, fetchModelOptions } from './models-dev'

describe('curatedOptions', () => {
  test('returns one entry per (provider, model) pair in KNOWN_PROVIDERS', () => {
    const options = curatedOptions()

    expect(options.length).toBeGreaterThan(0)
    expect(options.every((o) => o.curated)).toBe(true)
    expect(options.some((o) => o.providerId === 'openai')).toBe(true)
    expect(options.some((o) => o.providerId === 'fireworks')).toBe(true)
  })

  test('includes the kimi-k2p6-turbo router (curated, not on models.dev)', () => {
    const options = curatedOptions()

    const kimi = options.find((o) => o.modelId === 'accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(kimi).toBeDefined()
    expect(kimi?.providerId).toBe('fireworks')
  })
})

describe('fetchModelOptions', () => {
  test('falls back to curated list when fetch throws', async () => {
    // given: a fetch that always rejects (simulates offline init).
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.source).toBe('curated')
    expect(result.warning).toContain('network down')
    expect(result.options.length).toBeGreaterThan(0)
  })

  test('falls back to curated list on non-2xx response', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 502 })) as unknown as typeof fetch

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.source).toBe('curated')
    expect(result.warning).toContain('502')
  })

  test('merges live data with curated allowlist when fetch succeeds', async () => {
    // given: a stub response with a richer name for one curated model.
    const stub = {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.4-nano': {
            id: 'gpt-5.4-nano',
            name: 'GPT-5.4 nano (live)',
            reasoning: true,
            limit: { context: 400000 },
          },
        },
      },
      'fireworks-ai': {
        id: 'fireworks-ai',
        name: 'Fireworks AI',
        models: {},
      },
    }
    const fetchImpl = (async () =>
      new Response(JSON.stringify(stub), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.source).toBe('models.dev')
    const nano = result.options.find((o) => o.ref === 'openai/gpt-5.4-nano')
    expect(nano?.modelName).toBe('GPT-5.4 nano (live)')
    // kimi-k2p6-turbo is curated-only; must still appear even though models.dev didn't list it.
    expect(result.options.some((o) => o.modelId === 'accounts/fireworks/routers/kimi-k2p6-turbo')).toBe(true)
  })
})
