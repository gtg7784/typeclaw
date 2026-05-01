import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createSlackAuthorResolver } from './slack-bot-author-resolver'

type FetchCall = { url: string; init: RequestInit }

const SLACK_API_BASE = 'https://slack.com/api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('slack-bot author resolver', () => {
  let originalFetch: typeof fetch
  let calls: FetchCall[]

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const installFetch = (handler: (url: string) => Response | Promise<Response>): void => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return await handler(url)
    }) as unknown as typeof fetch
  }

  test('calls users.info with the bot token and returns profile.display_name', async () => {
    installFetch(() =>
      jsonResponse({
        ok: true,
        user: {
          id: 'UALICE',
          name: 'alice',
          real_name: 'Alice Smith',
          profile: { display_name: 'alice.s', real_name: 'Alice Smith' },
        },
      }),
    )
    const resolver = createSlackAuthorResolver({ token: 'xoxb-test', now: () => 1000 })

    const name = await resolver.resolve('UALICE')

    expect(name).toBe('alice.s')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${SLACK_API_BASE}/users.info?user=UALICE`)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer xoxb-test')
  })

  test('falls back to real_name when display_name is empty', async () => {
    installFetch(() =>
      jsonResponse({
        ok: true,
        user: {
          id: 'UBOB',
          name: 'bob',
          real_name: 'Bob Jones',
          profile: { display_name: '', real_name: 'Bob Jones' },
        },
      }),
    )
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => 1000 })

    const name = await resolver.resolve('UBOB')

    expect(name).toBe('Bob Jones')
  })

  test('falls back to name when real_name is also missing', async () => {
    installFetch(() =>
      jsonResponse({
        ok: true,
        user: { id: 'UCAROL', name: 'carol', profile: {} },
      }),
    )
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => 1000 })

    const name = await resolver.resolve('UCAROL')

    expect(name).toBe('carol')
  })

  test('returns the user id when Slack returns ok: false', async () => {
    installFetch(() => jsonResponse({ ok: false, error: 'user_not_found' }))
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => 1000 })

    const name = await resolver.resolve('UGHOST')

    expect(name).toBe('UGHOST')
  })

  test('returns the user id when the HTTP request fails', async () => {
    installFetch(() => new Response(null, { status: 503 }))
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => 1000 })

    const name = await resolver.resolve('UFLAKY')

    expect(name).toBe('UFLAKY')
  })

  test('returns the user id when fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => 1000 })

    const name = await resolver.resolve('UNETERR')

    expect(name).toBe('UNETERR')
  })

  test('caches successful lookups and does not re-fetch within TTL', async () => {
    let nowVal = 0
    installFetch(() =>
      jsonResponse({
        ok: true,
        user: { id: 'UALICE', name: 'alice', profile: { display_name: 'alice' } },
      }),
    )
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => nowVal, ttlMs: 60_000 })

    nowVal = 1000
    expect(await resolver.resolve('UALICE')).toBe('alice')
    nowVal = 50_000
    expect(await resolver.resolve('UALICE')).toBe('alice')

    expect(calls).toHaveLength(1)
  })

  test('re-fetches after TTL expires (handles renames)', async () => {
    let nowVal = 0
    let displayName = 'alice'
    installFetch(() =>
      jsonResponse({
        ok: true,
        user: { id: 'UALICE', name: 'alice', profile: { display_name: displayName } },
      }),
    )
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => nowVal, ttlMs: 60_000 })

    nowVal = 1000
    expect(await resolver.resolve('UALICE')).toBe('alice')
    displayName = 'alice.renamed'
    nowVal = 100_000
    expect(await resolver.resolve('UALICE')).toBe('alice.renamed')

    expect(calls).toHaveLength(2)
  })

  test('coalesces concurrent lookups for the same user (single fetch)', async () => {
    let resolveFetch: (response: Response) => void = () => {}
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return await new Promise<Response>((res) => {
        resolveFetch = res
      })
    }) as unknown as typeof fetch
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => 1000 })

    const a = resolver.resolve('UALICE')
    const b = resolver.resolve('UALICE')

    resolveFetch(
      jsonResponse({
        ok: true,
        user: { id: 'UALICE', name: 'alice', profile: { display_name: 'alice' } },
      }),
    )

    expect(await a).toBe('alice')
    expect(await b).toBe('alice')
    expect(calls).toHaveLength(1)
  })

  test('does not cache failures (so a transient error is retried next call)', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    installFetch(() =>
      mode === 'fail'
        ? new Response(null, { status: 500 })
        : jsonResponse({ ok: true, user: { id: 'UALICE', name: 'alice', profile: { display_name: 'alice' } } }),
    )
    const resolver = createSlackAuthorResolver({ token: 'tok', now: () => 1000 })

    expect(await resolver.resolve('UALICE')).toBe('UALICE')
    mode = 'ok'
    expect(await resolver.resolve('UALICE')).toBe('alice')

    expect(calls).toHaveLength(2)
  })
})
