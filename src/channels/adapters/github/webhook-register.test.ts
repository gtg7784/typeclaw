import { describe, expect, test } from 'bun:test'

import {
  deregisterGithubWebhooks,
  registerGithubWebhooks,
  type RegisterGithubWebhooksOptions,
  type WebhookRegistrationResult,
} from './webhook-register'

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

const PAT_TOKEN = async (): Promise<string> => 'ghp_testtoken'

function baseOpts(overrides: Partial<RegisterGithubWebhooksOptions> = {}): RegisterGithubWebhooksOptions {
  return {
    token: PAT_TOKEN,
    webhookUrl: 'https://agent.example.com/github',
    webhookSecret: 'secret-xyz',
    repos: ['acme/widgets'],
    events: ['issue_comment', 'pull_request'],
    fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    ...overrides,
  }
}

describe('registerGithubWebhooks', () => {
  test('creates a new hook when the repo has no matching hook yet', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.includes('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
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

  test('lists hooks with per_page=100 to reduce pagination misses', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.includes('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
        return { status: 200, body: [] }
      }
      return { status: 201, body: { id: 1 } }
    })

    await registerGithubWebhooks(baseOpts({ fetchImpl }))

    const listCall = calls.find((c) => (c.init?.method ?? 'GET') === 'GET')
    expect(listCall?.url).toContain('per_page=100')
  })

  test('updates an existing hook when one already points at the same URL (idempotent re-run)', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.includes('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
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

    expect(result.repos).toEqual([{ repo: 'acme/widgets', action: 'updated', hookId: 99, stalePruned: 0 }])
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
      if (url.includes('/repos/bad/repo/hooks') && method === 'GET') {
        return new Response('not found', { status: 404 })
      }
      if (url.includes('/repos/good/repo/hooks') && method === 'GET') {
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
      if (url.includes('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
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

  test('sends the token as a bearer header on every call', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.includes('/repos/acme/widgets/hooks') && (init?.method ?? 'GET') === 'GET') {
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

  test('rejects repo slugs with whitespace and path-traversal-like sequences', async () => {
    const { fetch: fetchImpl } = makeFetch(() => ({ status: 500 }))
    const result = await registerGithubWebhooks(
      baseOpts({ fetchImpl, repos: ['acme/widgets ', 'owner /repo', 'owner/..%2Fother', 'acme/widgets@v1'] }),
    )
    expect(result.repos.every((r) => r.action === 'failed')).toBe(true)
    for (const r of result.repos) {
      if (r.action === 'failed') expect(r.error).toContain('invalid repo slug')
    }
  })

  test('token acquisition failure surfaces as per-repo failures (no throw)', async () => {
    const { fetch: fetchImpl } = makeFetch(() => ({ status: 500 }))
    const result = await registerGithubWebhooks(
      baseOpts({
        fetchImpl,
        token: async () => {
          throw new Error('GitHub App has no installations')
        },
        repos: ['acme/widgets', 'acme/gadgets'],
      }),
    )
    expect(result.repos.length).toBe(2)
    for (const r of result.repos) {
      expect(r.action).toBe('failed')
      if (r.action === 'failed') expect(r.error).toContain('GitHub App has no installations')
    }
  })

  test('recognizes hooks from a prior run by managed-path marker even after the URL hostname rotated, then prunes stale orphans', async () => {
    const deleted: number[] = []
    let patched: number | null = null as number | null
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') {
        return {
          status: 200,
          body: [
            { id: 11, config: { url: 'https://old-A.trycloudflare.com/typeclaw/github/coder' } },
            { id: 22, config: { url: 'https://old-B.trycloudflare.com/typeclaw/github/coder' } },
            { id: 33, config: { url: 'https://unrelated.example.com/different-tool' } },
          ],
        }
      }
      const patchMatch = url.match(/\/repos\/acme\/widgets\/hooks\/(\d+)$/)
      if (patchMatch && method === 'PATCH') {
        patched = Number(patchMatch[1])
        return { status: 200, body: { id: Number(patchMatch[1]) } }
      }
      if (patchMatch && method === 'DELETE') {
        deleted.push(Number(patchMatch[1]))
        return { status: 204 }
      }
      return { status: 500 }
    })

    const result = await registerGithubWebhooks(
      baseOpts({
        fetchImpl,
        webhookUrl: 'https://new-C.trycloudflare.com/typeclaw/github/coder',
        managedPath: '/typeclaw/github/coder',
      }),
    )

    expect(result.repos.length).toBe(1)
    const repo = result.repos[0]!
    expect(repo.action).toBe('updated')
    if (repo.action !== 'updated') throw new Error('unreachable')
    expect(repo.hookId).toBe(11)
    expect(repo.stalePruned).toBe(1)
    expect(patched).toBe(11)
    expect(deleted).toEqual([22])
    expect(calls.every((c) => !c.url.endsWith('/hooks/33'))).toBe(true)
  })

  test('PATCH targets the current webhookUrl so a rotated tunnel hostname is repaired in place', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') {
        return {
          status: 200,
          body: [{ id: 5, config: { url: 'https://stale.trycloudflare.com/typeclaw/github/coder' } }],
        }
      }
      if (url.endsWith('/repos/acme/widgets/hooks/5') && method === 'PATCH') return { status: 200, body: { id: 5 } }
      return { status: 500 }
    })

    await registerGithubWebhooks(
      baseOpts({
        fetchImpl,
        webhookUrl: 'https://fresh.trycloudflare.com/typeclaw/github/coder',
        managedPath: '/typeclaw/github/coder',
      }),
    )

    const patch = calls.find((c) => c.init?.method === 'PATCH')
    expect(patch).toBeDefined()
    const body = JSON.parse(String(patch!.init?.body)) as { config: { url: string } }
    expect(body.config.url).toBe('https://fresh.trycloudflare.com/typeclaw/github/coder')
  })

  test("a foreign agent's hook (different managed-path marker on the same host) is not claimed", async () => {
    let createdId: number | null = null as number | null
    const { fetch: fetchImpl } = makeFetch(({ url, init }) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') {
        return {
          status: 200,
          body: [{ id: 9, config: { url: 'https://anything.trycloudflare.com/typeclaw/github/other-agent' } }],
        }
      }
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST') {
        createdId = 42
        return { status: 201, body: { id: 42 } }
      }
      return { status: 500 }
    })

    const result = await registerGithubWebhooks(
      baseOpts({
        fetchImpl,
        webhookUrl: 'https://new.trycloudflare.com/typeclaw/github/coder',
        managedPath: '/typeclaw/github/coder',
      }),
    )

    expect(result.repos[0]?.action).toBe('created')
    expect(createdId).toBe(42)
  })

  test('without managedPath, prior-run hooks at a rotated URL are NOT recognized (regression baseline — proves the marker is the load-bearing fix)', async () => {
    let createdId: number | null = null as number | null
    const { fetch: fetchImpl } = makeFetch(({ url, init }) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') {
        return {
          status: 200,
          body: [{ id: 11, config: { url: 'https://old.trycloudflare.com/typeclaw/github/coder' } }],
        }
      }
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST') {
        createdId = 50
        return { status: 201, body: { id: 50 } }
      }
      return { status: 500 }
    })

    const result = await registerGithubWebhooks(
      baseOpts({
        fetchImpl,
        webhookUrl: 'https://new.trycloudflare.com/typeclaw/github/coder',
      }),
    )

    expect(result.repos[0]?.action).toBe('created')
    expect(createdId).toBe(50)
  })
})

describe('deregisterGithubWebhooks', () => {
  test('deletes each managed hook and reports per-hook outcome', async () => {
    const { fetch: fetchImpl, calls } = makeFetch(({ url, init }) => {
      if (url.endsWith('/repos/acme/widgets/hooks/42') && init?.method === 'DELETE') {
        return { status: 204 }
      }
      if (url.endsWith('/repos/acme/gadgets/hooks/77') && init?.method === 'DELETE') {
        return { status: 404 }
      }
      return { status: 500 }
    })

    const result = await deregisterGithubWebhooks({
      token: PAT_TOKEN,
      hooks: [
        { repo: 'acme/widgets', hookId: 42 },
        { repo: 'acme/gadgets', hookId: 77 },
      ],
      fetchImpl,
    })

    expect(result.hooks).toEqual([
      { repo: 'acme/widgets', hookId: 42, action: 'deleted' },
      { repo: 'acme/gadgets', hookId: 77, action: 'missing' },
    ])
    expect(calls.every((c) => c.init?.method === 'DELETE')).toBe(true)
  })

  test('continues when one delete fails', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/repos/a/b/hooks/1') && init?.method === 'DELETE') {
        return new Response('forbidden', { status: 403 })
      }
      if (url.endsWith('/repos/c/d/hooks/2') && init?.method === 'DELETE') {
        return new Response('', { status: 204 })
      }
      return new Response('', { status: 500 })
    }) as unknown as typeof fetch

    const result = await deregisterGithubWebhooks({
      token: PAT_TOKEN,
      hooks: [
        { repo: 'a/b', hookId: 1 },
        { repo: 'c/d', hookId: 2 },
      ],
      fetchImpl,
    })

    expect(result.hooks[0]?.action).toBe('failed')
    expect(result.hooks[1]?.action).toBe('deleted')
  })

  test('token acquisition failure surfaces as per-hook failures (no throw)', async () => {
    const { fetch: fetchImpl } = makeFetch(() => ({ status: 500 }))
    const result = await deregisterGithubWebhooks({
      token: async () => {
        throw new Error('token expired')
      },
      hooks: [{ repo: 'acme/widgets', hookId: 42 }],
      fetchImpl,
    })
    expect(result.hooks[0]?.action).toBe('failed')
  })
})
