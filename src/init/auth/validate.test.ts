import { describe, expect, test } from 'bun:test'

import { API_KEY_DASHBOARD_URL, validateApiKey, type FetchFn } from './validate'

function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): FetchFn {
  return async (url, init) => responder(url, init)
}

describe('validateApiKey', () => {
  test('returns ok when the provider accepts the key', async () => {
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch((url, init) => {
        expect(url).toBe('https://api.openai.com/v1/models')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
        return new Response('{"data":[]}', { status: 200 })
      }),
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  test('returns rejected on 401', async () => {
    const result = await validateApiKey(
      'openai',
      'bad-key',
      fakeFetch(() => new Response('{"error":"invalid"}', { status: 401 })),
    )
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.status).toBe(401)
      expect(result.detail).toContain('invalid')
    }
  })

  test('uses x-api-key + anthropic-version for Anthropic', async () => {
    let seenHeaders: Record<string, string> | null = null
    await validateApiKey(
      'anthropic',
      'sk-ant-test',
      fakeFetch((_url, init) => {
        seenHeaders = init.headers as Record<string, string>
        return new Response('{}', { status: 200 })
      }),
    )
    expect(seenHeaders!['x-api-key']).toBe('sk-ant-test')
    expect(seenHeaders!['anthropic-version']).toBe('2023-06-01')
    expect(seenHeaders!.Authorization).toBeUndefined()
  })

  test('returns skipped/no-probe for OAuth-only providers', async () => {
    const result = await validateApiKey(
      'openai-codex',
      'whatever',
      fakeFetch(() => new Response()),
    )
    expect(result).toEqual({ kind: 'skipped', reason: 'no-probe' })
  })

  test('returns skipped/network-error on fetch rejection', async () => {
    const result = await validateApiKey('openai', 'sk-test', async () => {
      throw new Error('ENOTFOUND')
    })
    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('network-error')
      expect(result.detail).toContain('ENOTFOUND')
    }
  })

  test('returns skipped (not rejected) on non-auth 4xx/5xx so flakiness does not block init', async () => {
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch(() => new Response('', { status: 503 })),
    )
    expect(result).toEqual({ kind: 'skipped', reason: 'network-error', detail: 'HTTP 503' })
  })
})

describe('API_KEY_DASHBOARD_URL', () => {
  test('covers every api-key-supporting provider', () => {
    expect(API_KEY_DASHBOARD_URL.openai).toBeDefined()
    expect(API_KEY_DASHBOARD_URL.anthropic).toBeDefined()
    expect(API_KEY_DASHBOARD_URL.fireworks).toBeDefined()
    expect(API_KEY_DASHBOARD_URL.zai).toBeDefined()
    expect(API_KEY_DASHBOARD_URL['zai-coding']).toBeDefined()
  })
})
