import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createSlackChannelResolver } from './slack-bot-channel-resolver'

type FetchCall = { url: string; init: RequestInit }

const SLACK_API_BASE = 'https://slack.com/api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('slack-bot channel resolver', () => {
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

  test('resolves chat name and workspace name in parallel from conversations.info and team.info', async () => {
    installFetch((url) => {
      if (url.includes('/conversations.info')) {
        return jsonResponse({ ok: true, channel: { id: 'C0DEPLOY', name: 'deploy' } })
      }
      if (url.includes('/team.info')) {
        return jsonResponse({ ok: true, team: { id: 'T0ACME', name: 'Acme Corp' } })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    const resolver = createSlackChannelResolver({ token: 'xoxb-test', now: () => 1000 })

    const result = await resolver({
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      chat: 'C0DEPLOY',
      thread: null,
    })

    expect(result).toEqual({ chatName: 'deploy', workspaceName: 'Acme Corp' })
    expect(calls).toHaveLength(2)
    const conv = calls.find((c) => c.url.includes('/conversations.info'))!
    expect(conv.url).toBe(`${SLACK_API_BASE}/conversations.info?channel=C0DEPLOY`)
    expect((conv.init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test')
    const team = calls.find((c) => c.url.includes('/team.info'))!
    expect(team.url).toBe(`${SLACK_API_BASE}/team.info?team=T0ACME`)
  })

  test('skips both lookups for DM channels (workspace=@dm)', async () => {
    installFetch(() => jsonResponse({ ok: true }))
    const resolver = createSlackChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'slack-bot', workspace: '@dm', chat: 'D0DMID', thread: null })

    expect(result).toEqual({})
    expect(calls).toHaveLength(0)
  })

  test('returns workspace name only when the channel lookup fails', async () => {
    installFetch((url) => {
      if (url.includes('/conversations.info')) return new Response(null, { status: 500 })
      return jsonResponse({ ok: true, team: { id: 'T0', name: 'Acme' } })
    })
    const resolver = createSlackChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null })

    expect(result).toEqual({ workspaceName: 'Acme' })
  })

  test('returns chat name only when the team lookup fails', async () => {
    installFetch((url) => {
      if (url.includes('/team.info')) return jsonResponse({ ok: false, error: 'auth_revoked' })
      return jsonResponse({ ok: true, channel: { id: 'C0', name: 'general' } })
    })
    const resolver = createSlackChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null })

    expect(result).toEqual({ chatName: 'general' })
  })

  test('caches resolved names within TTL (no re-fetch on repeat lookup)', async () => {
    let nowVal = 1000
    installFetch((url) =>
      jsonResponse(
        url.includes('/conversations.info')
          ? { ok: true, channel: { id: 'C0', name: 'general' } }
          : { ok: true, team: { id: 'T0', name: 'Acme' } },
      ),
    )
    const resolver = createSlackChannelResolver({ token: 'tok', now: () => nowVal, ttlMs: 60_000 })

    await resolver({ adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null })
    nowVal = 50_000
    await resolver({ adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null })

    expect(calls).toHaveLength(2)
  })

  test('re-fetches after TTL expires', async () => {
    let nowVal = 1000
    let chatName = 'general'
    installFetch((url) =>
      jsonResponse(
        url.includes('/conversations.info')
          ? { ok: true, channel: { id: 'C0', name: chatName } }
          : { ok: true, team: { id: 'T0', name: 'Acme' } },
      ),
    )
    const resolver = createSlackChannelResolver({ token: 'tok', now: () => nowVal, ttlMs: 60_000 })

    await resolver({ adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null })
    chatName = 'general-renamed'
    nowVal = 100_000
    const second = await resolver({ adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null })

    expect(second.chatName).toBe('general-renamed')
  })

  test('returns empty object on total network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const resolver = createSlackChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null })

    expect(result).toEqual({})
  })
})
