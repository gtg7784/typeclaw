import { describe, expect, test } from 'bun:test'

import { formatEagerGithubWebhookInstallResult, installGithubWebhooksEagerly } from './github-webhook-install'

type RecordedCall = { url: string; method: string; body?: string }

function fakeGithubFetch(handler: (url: string, method: string) => Response): {
  fn: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push(body !== undefined ? { url, method, body } : { url, method })
    return handler(url, method)
  }
  return { fn: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, calls }
}

describe('installGithubWebhooksEagerly', () => {
  test('registers a webhook per repo and returns a structured result', async () => {
    let nextId = 100
    const { fn, calls } = fakeGithubFetch((url, method) => {
      if (/\/hooks(\?|$)/.test(url) && method === 'GET') return Response.json([])
      if (url.endsWith('/hooks') && method === 'POST') return Response.json({ id: nextId++ }, { status: 201 })
      return new Response('unexpected', { status: 500 })
    })

    const result = await installGithubWebhooksEagerly({
      webhookUrl: 'https://agent.example.com/gh',
      webhookSecret: 'wh-secret',
      repos: ['acme/widgets', 'acme/gadgets'],
      auth: { type: 'pat', pat: 'ghp_test' },
      fetchImpl: fn,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) throw new Error('unreachable')
    expect(result.repos).toEqual([
      { repo: 'acme/widgets', action: 'created', hookId: 100 },
      { repo: 'acme/gadgets', action: 'created', hookId: 101 },
    ])
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/hooks',
      'https://api.github.com/repos/acme/gadgets/hooks',
    ])
  })

  test('updates an existing webhook (PATCH) when one with the same URL already exists', async () => {
    const { fn, calls } = fakeGithubFetch((url, method) => {
      if (/\/hooks(\?|$)/.test(url) && method === 'GET') {
        return Response.json([{ id: 999, config: { url: 'https://agent.example.com/gh' } }])
      }
      if (url.endsWith('/hooks/999') && method === 'PATCH') return new Response('', { status: 200 })
      return new Response('unexpected', { status: 500 })
    })

    const result = await installGithubWebhooksEagerly({
      webhookUrl: 'https://agent.example.com/gh',
      webhookSecret: 'wh-secret',
      repos: ['acme/widgets'],
      auth: { type: 'pat', pat: 'ghp_test' },
      fetchImpl: fn,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) throw new Error('unreachable')
    expect(result.repos).toEqual([{ repo: 'acme/widgets', action: 'updated', hookId: 999 }])
    expect(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/hooks/999'))).toBe(true)
  })

  test('repos[] empty returns an empty result and makes no HTTP calls', async () => {
    const { fn, calls } = fakeGithubFetch(() => new Response('unexpected', { status: 500 }))

    const result = await installGithubWebhooksEagerly({
      webhookUrl: 'https://agent.example.com/gh',
      webhookSecret: 'wh-secret',
      repos: [],
      auth: { type: 'pat', pat: 'ghp_test' },
      fetchImpl: fn,
    })

    expect(result).toEqual({ repos: [] })
    expect(calls).toEqual([])
  })

  test('per-repo 4xx is surfaced as { action: failed } rather than throwing', async () => {
    const { fn } = fakeGithubFetch((url, method) => {
      if (url.endsWith('acme/widgets/hooks?per_page=100') && method === 'GET') {
        return new Response('forbidden', { status: 403 })
      }
      if (/\/hooks(\?|$)/.test(url) && method === 'GET') return Response.json([])
      if (url.endsWith('/hooks') && method === 'POST') return Response.json({ id: 1 }, { status: 201 })
      return new Response('unexpected', { status: 500 })
    })

    const result = await installGithubWebhooksEagerly({
      webhookUrl: 'https://agent.example.com/gh',
      webhookSecret: 'wh-secret',
      repos: ['acme/widgets', 'acme/gadgets'],
      auth: { type: 'pat', pat: 'ghp_test' },
      fetchImpl: fn,
    })

    expect('error' in result).toBe(false)
    if ('error' in result) throw new Error('unreachable')
    expect(result.repos[0]).toMatchObject({ repo: 'acme/widgets', action: 'failed' })
    expect(result.repos[1]).toMatchObject({ repo: 'acme/gadgets', action: 'created' })
  })

  test('invalid auth (missing PAT) is surfaced as a top-level error, not a throw', async () => {
    const { fn } = fakeGithubFetch(() => new Response('unexpected', { status: 500 }))

    const result = await installGithubWebhooksEagerly({
      webhookUrl: 'https://agent.example.com/gh',
      webhookSecret: 'wh-secret',
      repos: ['acme/widgets'],
      auth: { type: 'pat', pat: '' },
      fetchImpl: fn,
    })

    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('unreachable')
    expect(result.error).toContain('GitHub PAT token is missing')
  })
})

describe('formatEagerGithubWebhookInstallResult', () => {
  test('summarizes created and updated counts', () => {
    expect(
      formatEagerGithubWebhookInstallResult({
        repos: [
          { repo: 'a/b', action: 'created', hookId: 1 },
          { repo: 'a/c', action: 'updated', hookId: 2 },
        ],
      }),
    ).toBe('GitHub webhooks: 1 created, 1 updated.')
  })

  test('includes per-repo error tail when some hooks failed', () => {
    expect(
      formatEagerGithubWebhookInstallResult({
        repos: [
          { repo: 'a/b', action: 'created', hookId: 1 },
          { repo: 'a/c', action: 'failed', error: '403 forbidden' },
        ],
      }),
    ).toBe('GitHub webhooks: 1 created, 1 failed. (a/c: 403 forbidden)')
  })

  test('reports the strategy-level error when auth setup itself failed', () => {
    expect(formatEagerGithubWebhookInstallResult({ error: 'GitHub PAT token is missing', repos: [] })).toBe(
      'GitHub webhook install failed: GitHub PAT token is missing',
    )
  })

  test('reports "no repos" on an empty result', () => {
    expect(formatEagerGithubWebhookInstallResult({ repos: [] })).toBe('GitHub webhooks: no repos.')
  })
})
