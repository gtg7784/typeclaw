import { describe, expect, test } from 'bun:test'

import {
  registerGithubWebhooks,
  type RegisterGithubWebhooksOptions,
  type WebhookRegistrationResult,
} from './github-webhook-register'

type FetchCall = { url: string; init: RequestInit | undefined }

function makeFetch(handler: (call: FetchCall) => { status: number; body?: unknown }): {
  fetch: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    const result = handler({ url, init })
    const body = result.body === undefined ? '' : JSON.stringify(result.body)
    return new Response(body, {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: fakeFetch, calls }
}

const PAT_AUTH = { type: 'pat' as const, pat: 'ghp_testtoken' }

function baseOpts(overrides: Partial<RegisterGithubWebhooksOptions> = {}): RegisterGithubWebhooksOptions {
  return {
    auth: PAT_AUTH,
    webhookUrl: 'https://agent.example.com/github',
    webhookSecret: 'secret-xyz',
    repos: ['acme/widgets'],
    events: ['issue_comment', 'pull_request'],
    fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    ...overrides,
  }
}

describe('registerGithubWebhooks (PAT auth)', () => {
  test('creates a new hook when the repo has no matching hook yet', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.endsWith('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
        return { status: 200, body: [] }
      }
      if (url.endsWith('/repos/acme/widgets/hooks') && init?.method === 'POST') {
        return { status: 201, body: { id: 42 } }
      }
      return { status: 500 }
    })

    const result = await registerGithubWebhooks(baseOpts({ fetchImpl }))

    expect(result.repos).toEqual([{ repo: 'acme/widgets', action: 'created', hookId: 42 }])
    const post = calls.find((c) => c.init?.method === 'POST')
    expect(post).toBeDefined()
    const body = JSON.parse(String(post!.init?.body)) as {
      name: string
      active: boolean
      events: string[]
      config: { url: string; content_type: string; secret: string; insecure_ssl: string }
    }
    expect(body.name).toBe('web')
    expect(body.active).toBe(true)
    expect(body.events).toEqual(['issue_comment', 'pull_request'])
    expect(body.config.url).toBe('https://agent.example.com/github')
    expect(body.config.content_type).toBe('json')
    expect(body.config.secret).toBe('secret-xyz')
    expect(body.config.insecure_ssl).toBe('0')
  })

  test('updates an existing hook when one already points at the same URL (idempotent re-run)', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.endsWith('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
        return {
          status: 200,
          body: [
            {
              id: 99,
              config: { url: 'https://agent.example.com/github' },
              events: ['issues'],
              active: false,
            },
          ],
        }
      }
      if (url.endsWith('/repos/acme/widgets/hooks/99') && init?.method === 'PATCH') {
        return { status: 200, body: { id: 99 } }
      }
      return { status: 500 }
    })

    const result = await registerGithubWebhooks(baseOpts({ fetchImpl }))

    expect(result.repos).toEqual([{ repo: 'acme/widgets', action: 'updated', hookId: 99 }])
    const patch = calls.find((c) => c.init?.method === 'PATCH')
    expect(patch).toBeDefined()
    const body = JSON.parse(String(patch!.init?.body)) as {
      active: boolean
      events: string[]
      config: { url: string; secret: string }
    }
    expect(body.active).toBe(true)
    expect(body.events).toEqual(['issue_comment', 'pull_request'])
    expect(body.config.url).toBe('https://agent.example.com/github')
    expect(body.config.secret).toBe('secret-xyz')
  })

  test('continues to the next repo when one fails (does not throw)', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      if (url.endsWith('/repos/bad/repo/hooks') && method === 'GET') {
        return new Response('not found', { status: 404 })
      }
      if (url.endsWith('/repos/good/repo/hooks') && method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.endsWith('/repos/good/repo/hooks') && method === 'POST') {
        return new Response(JSON.stringify({ id: 7 }), { status: 201 })
      }
      return new Response('', { status: 500 })
    }) as unknown as typeof fetch

    const result = await registerGithubWebhooks(baseOpts({ fetchImpl, repos: ['bad/repo', 'good/repo'] }))

    expect(result.repos.length).toBe(2)
    const bad = result.repos.find((r) => r.repo === 'bad/repo')
    const good = result.repos.find((r) => r.repo === 'good/repo')
    expect(bad?.action).toBe('failed')
    expect((bad as Extract<WebhookRegistrationResult['repos'][number], { action: 'failed' }>).error).toContain('404')
    expect(good?.action).toBe('created')
  })

  test('reduces dotted event.action names to coarse event names for the hook config', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.endsWith('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
        return { status: 200, body: [] }
      }
      return { status: 201, body: { id: 1 } }
    })

    await registerGithubWebhooks(
      baseOpts({
        fetchImpl,
        events: ['issue_comment.created', 'pull_request.opened', 'pull_request.synchronize'],
      }),
    )

    const post = calls.find((c) => c.init?.method === 'POST')
    const body = JSON.parse(String(post!.init?.body)) as { events: string[] }
    expect([...body.events].sort()).toEqual(['issue_comment', 'pull_request'])
  })

  test('sends the PAT as a bearer token on every call', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.endsWith('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
        return { status: 200, body: [] }
      }
      return { status: 201, body: { id: 1 } }
    })

    await registerGithubWebhooks(baseOpts({ fetchImpl }))

    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer ghp_testtoken')
      expect(headers.get('Accept')).toBe('application/vnd.github+json')
    }
  })
})

describe('registerGithubWebhooks (App auth)', () => {
  test('mints an installation token before creating the hook', async () => {
    const privateKey = await generateTestRsaPem()

    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      const method = init?.method ?? 'GET'
      if (url.endsWith('/app/installations') && method === 'GET') {
        return { status: 200, body: [{ id: 555 }] }
      }
      if (url.endsWith('/app/installations/555/access_tokens') && method === 'POST') {
        return {
          status: 201,
          body: { token: 'ghs_installtoken', expires_at: new Date(Date.now() + 3600_000).toISOString() },
        }
      }
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'GET') {
        return { status: 200, body: [] }
      }
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST') {
        return { status: 201, body: { id: 11 } }
      }
      return { status: 500 }
    })

    const result = await registerGithubWebhooks(
      baseOpts({
        fetchImpl,
        auth: { type: 'app', appId: 123, privateKey },
      }),
    )

    expect(result.repos[0]?.action).toBe('created')
    const hookListCall = calls.find(
      (c) => c.url.endsWith('/repos/acme/widgets/hooks') && (c.init?.method ?? 'GET') === 'GET',
    )
    expect(new Headers(hookListCall?.init?.headers).get('Authorization')).toBe('Bearer ghs_installtoken')
  })
})

async function generateTestRsaPem(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const exported = await crypto.subtle.exportKey('pkcs8', key.privateKey)
  const b64 = Buffer.from(exported).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? [b64]
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}
