import { describe, expect, test } from 'bun:test'

import { createChannelRouter, type ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig, GithubAdapterConfig } from '@/channels/schema'
import type { GithubSecretsBlock } from '@/secrets/schema'

import { createGithubAdapter } from './index'

type Call = { url: string; method: string; body?: string }

function fakeFetchRecording(handler: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
    return handler({ url, method })
  }
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, calls }
}

function silentLogger(): { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

function recordingLogger(): {
  info: (m: string) => void
  warn: (m: string) => void
  error: (m: string) => void
  messages: string[]
} {
  const messages: string[] = []
  return {
    info: (m) => messages.push(`info:${m}`),
    warn: (m) => messages.push(`warn:${m}`),
    error: (m) => messages.push(`error:${m}`),
    messages,
  }
}

function patSecrets(): GithubSecretsBlock {
  return {
    auth: { type: 'pat', token: { value: 'ghp_test' } },
    webhookSecret: { value: 'wh-secret' },
  }
}

const ADAPTER_DEFAULTS = {
  enabled: true,
  engagement: { trigger: ['mention', 'reply', 'dm'] as const, stickiness: { perReply: { window: 60_000 } } },
  history: { prefetch: { thread: { head: 3, tail: 10 }, channel: { tail: 10 } } },
} as const

function githubConfig(
  repos: readonly string[],
  webhookUrl: string | null = 'https://agent.example.com/gh',
): ChannelAdapterConfig & GithubAdapterConfig {
  const config: ChannelAdapterConfig & GithubAdapterConfig = {
    ...ADAPTER_DEFAULTS,
    engagement: { ...ADAPTER_DEFAULTS.engagement, trigger: [...ADAPTER_DEFAULTS.engagement.trigger] },
    webhookPort: 0,
    eventAllowlist: ['issue_comment.created', 'pull_request.opened'],
    repos: [...repos],
  }
  if (webhookUrl !== null) config.webhookUrl = webhookUrl
  return config
}

function freshRouter(): ChannelRouter {
  return createChannelRouter({
    agentDir: '/tmp/agent',
    configForAdapter: () => ({
      ...ADAPTER_DEFAULTS,
      engagement: { ...ADAPTER_DEFAULTS.engagement, trigger: [...ADAPTER_DEFAULTS.engagement.trigger] },
    }),
  })
}

describe('createGithubAdapter lifecycle', () => {
  test('start() registers a webhook for every configured repo', async () => {
    const created: Array<{ repo: string; hookId: number }> = []
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') {
        return Response.json({ login: 'bot', id: 1 })
      }
      const match = url.match(/\/repos\/([^/]+)\/([^/]+)\/hooks\b/)
      if (match) {
        if (method === 'GET') return Response.json([])
        if (method === 'POST') {
          const repo = `${match[1]}/${match[2]}`
          const hookId = 100 + created.length
          created.push({ repo, hookId })
          return Response.json({ id: hookId }, { status: 201 })
        }
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets', 'acme/gadgets']),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
    })

    await adapter.start()
    await adapter.stop()

    expect(created).toEqual([
      { repo: 'acme/widgets', hookId: 100 },
      { repo: 'acme/gadgets', hookId: 101 },
    ])
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/hooks'))).toBe(true)
  })

  test('start() registers with configured webhookUrl when no tunnel URL callback is provided', async () => {
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json([])
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST')
        return Response.json({ id: 42 }, { status: 201 })
      if (method === 'DELETE') return new Response('', { status: 204 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
    })

    await adapter.start()
    await adapter.stop()

    const registration = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/hooks'))
    expect(registration?.body).toContain('https://agent.example.com/gh')
  })

  test('start() registers with tunnel URL when webhookUrl is omitted', async () => {
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json([])
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST')
        return Response.json({ id: 42 }, { status: 201 })
      if (method === 'DELETE') return new Response('', { status: 204 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => 'https://x.trycloudflare.com',
    })

    await adapter.start()
    await adapter.stop()

    const registration = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/hooks'))
    expect(registration?.body).toContain('https://x.trycloudflare.com')
  })

  test('start() prefers configured webhookUrl over tunnel URL', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json([])
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST')
        return Response.json({ id: 42 }, { status: 201 })
      if (method === 'DELETE') return new Response('', { status: 204 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], 'https://configured.example.com/gh'),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => 'https://x.trycloudflare.com',
    })

    await adapter.start()
    await adapter.stop()

    const registration = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/hooks'))
    expect(registration?.body).toContain('https://configured.example.com/gh')
    expect(registration?.body).not.toContain('https://x.trycloudflare.com')
    expect(logger.messages).toContain(
      'warn:[github] webhookUrl configured; ignoring tunnel URL for webhook registration',
    )
  })

  test('start() skips webhook registration (no tunnel configured) with an actionable WARN, not a quiet INFO', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelConfiguredForChannel: () => false,
    })

    await adapter.start()
    await adapter.stop()

    expect(calls.some((c) => c.url.includes('/hooks'))).toBe(false)
    const skipMsg = logger.messages.find((m) => m.includes('webhook registration SKIPPED'))
    expect(skipMsg).toBeDefined()
    expect(skipMsg).toContain('warn:')
    expect(skipMsg).toContain('no `channels.github.webhookUrl` set and no `tunnels[]` entry')
    expect(skipMsg).toContain('cloudflare-quick')
  })

  test('start() skips webhook registration (tunnel configured but URL not ready) names the tunnel as the failure surface', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => null,
      tunnelConfiguredForChannel: () => true,
    })

    await adapter.start()
    await adapter.stop()

    expect(calls.some((c) => c.url.includes('/hooks'))).toBe(false)
    const skipMsg = logger.messages.find((m) => m.includes('webhook registration SKIPPED'))
    expect(skipMsg).toBeDefined()
    expect(skipMsg).toContain('warn:')
    expect(skipMsg).toContain('tunnel is configured for this channel but produced no URL yet')
    expect(skipMsg).toContain('typeclaw tunnel status')
  })

  test('start() emits a quiet INFO (not WARN) when no repos are configured — there is nothing to register', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([], null),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelConfiguredForChannel: () => true,
    })

    await adapter.start()
    await adapter.stop()

    expect(logger.messages).toContain('info:[github] no repos[] configured; webhook registration skipped')
    expect(logger.messages.some((m) => m.includes('warn:[github] webhook registration SKIPPED'))).toBe(false)
  })

  test('stop() deletes every hook registered by start() (detach on close)', async () => {
    const deleted: number[] = []
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json([])
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST') {
        return Response.json({ id: 42 }, { status: 201 })
      }
      const del = url.match(/\/repos\/acme\/widgets\/hooks\/(\d+)$/)
      if (del && method === 'DELETE') {
        deleted.push(Number(del[1]))
        return new Response('', { status: 204 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
    })

    await adapter.start()
    await adapter.stop()

    expect(deleted).toEqual([42])
  })

  test('repos[] empty: start/stop are no-ops on the GitHub hooks API', async () => {
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([]),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
    })

    await adapter.start()
    await adapter.stop()

    expect(calls.some((c) => c.url.includes('/hooks'))).toBe(false)
  })

  test('webhook register failure does not block adapter start (best-effort)', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks')) return new Response('forbidden', { status: 403 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    await adapter.stop()
  })

  test('rotating tunnel URL across two adapter lifecycles: second start adopts and updates the prior hook instead of orphaning it', async () => {
    type Hook = { id: number; config: { url: string } }
    let nextHookId = 1000
    const repoHooks: Hook[] = []
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json(repoHooks)
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST') {
        const hook = { id: nextHookId++, config: { url: 'pending' } }
        repoHooks.push(hook)
        return Response.json({ id: hook.id }, { status: 201 })
      }
      const idMatch = url.match(/\/repos\/acme\/widgets\/hooks\/(\d+)$/)
      if (idMatch && method === 'PATCH') return Response.json({ id: Number(idMatch[1]) })
      if (idMatch && method === 'DELETE') {
        const id = Number(idMatch[1])
        const idx = repoHooks.findIndex((h) => h.id === id)
        if (idx >= 0) repoHooks.splice(idx, 1)
        return new Response('', { status: 204 })
      }
      return new Response('unexpected', { status: 500 })
    })

    let currentTunnelUrl = 'https://first.trycloudflare.com'
    const router1 = freshRouter()
    const adapter1 = createGithubAdapter({
      router: router1,
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir: '/tmp/coder',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => currentTunnelUrl,
    })
    await adapter1.start()
    expect(repoHooks.length).toBe(1)
    const firstHookId = repoHooks[0]!.id

    repoHooks[0] = { id: firstHookId, config: { url: 'https://first.trycloudflare.com/typeclaw/v1/github/coder' } }
    currentTunnelUrl = 'https://second.trycloudflare.com'

    const router2 = freshRouter()
    const adapter2 = createGithubAdapter({
      router: router2,
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir: '/tmp/coder',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => currentTunnelUrl,
    })
    await adapter2.start()

    expect(repoHooks.length).toBe(1)
    expect(repoHooks[0]?.id).toBe(firstHookId)

    await adapter2.stop()
    expect(repoHooks.length).toBe(0)
  })

  test('stop() does not attempt detach when no hooks were registered (e.g. registration failed)', async () => {
    const deleted: string[] = []
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') {
        return new Response('forbidden', { status: 403 })
      }
      if (method === 'DELETE') {
        deleted.push(url)
        return new Response('', { status: 204 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir: '/tmp/agent',
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
    })

    await adapter.start()
    await adapter.stop()

    expect(deleted).toEqual([])
  })
})
