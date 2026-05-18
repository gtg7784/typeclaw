import { describe, expect, test } from 'bun:test'

import { createChannelRouter, type ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig, GithubAdapterConfig } from '@/channels/schema'
import type { GithubSecretsBlock } from '@/secrets/schema'

import { createGithubAdapter } from './index'

type Call = { url: string; method: string }

function fakeFetchRecording(handler: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    return handler({ url, method })
  }
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, calls }
}

function silentLogger(): { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } {
  return { info: () => {}, warn: () => {}, error: () => {} }
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

function githubConfig(repos: readonly string[]): ChannelAdapterConfig & GithubAdapterConfig {
  return {
    ...ADAPTER_DEFAULTS,
    engagement: { ...ADAPTER_DEFAULTS.engagement, trigger: [...ADAPTER_DEFAULTS.engagement.trigger] },
    webhookUrl: 'https://agent.example.com/gh',
    webhookPort: 0,
    eventAllowlist: ['issue_comment.created', 'pull_request.opened'],
    repos: [...repos],
  }
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
