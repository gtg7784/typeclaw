import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createDiscordChannelResolver } from './discord-bot-channel-resolver'

type FetchCall = { url: string; init: RequestInit }

const DISCORD_API_BASE = 'https://discord.com/api/v10'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('discord-bot channel resolver', () => {
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

  test('resolves chat name and guild name from /channels and /guilds', async () => {
    installFetch((url) => {
      if (url.endsWith('/channels/222')) return jsonResponse({ id: '222', name: 'general' })
      if (url.endsWith('/guilds/111')) return jsonResponse({ id: '111', name: 'Acme Guild' })
      throw new Error(`unexpected url: ${url}`)
    })
    const resolver = createDiscordChannelResolver({ token: 'tok-abc', now: () => 1000 })

    const result = await resolver({ adapter: 'discord-bot', workspace: '111', chat: '222', thread: null })

    expect(result).toEqual({ chatName: 'general', workspaceName: 'Acme Guild' })
    expect(calls).toHaveLength(2)
    const channelCall = calls.find((c) => c.url.endsWith('/channels/222'))!
    expect(channelCall.url).toBe(`${DISCORD_API_BASE}/channels/222`)
    expect((channelCall.init.headers as Record<string, string>).Authorization).toBe('Bot tok-abc')
  })

  test('skips both lookups for DM workspace (workspace=@dm)', async () => {
    installFetch(() => jsonResponse({}))
    const resolver = createDiscordChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null })

    expect(result).toEqual({})
    expect(calls).toHaveLength(0)
  })

  test('returns workspace name only when channel lookup 404s', async () => {
    installFetch((url) => {
      if (url.includes('/channels/')) return new Response(null, { status: 404 })
      return jsonResponse({ id: '111', name: 'Acme' })
    })
    const resolver = createDiscordChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'discord-bot', workspace: '111', chat: '222', thread: null })

    expect(result).toEqual({ workspaceName: 'Acme' })
  })

  test('returns chat name only when guild lookup fails', async () => {
    installFetch((url) => {
      if (url.includes('/guilds/')) return new Response(null, { status: 500 })
      return jsonResponse({ id: '222', name: 'general' })
    })
    const resolver = createDiscordChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'discord-bot', workspace: '111', chat: '222', thread: null })

    expect(result).toEqual({ chatName: 'general' })
  })

  test('handles a channel with no name field by omitting chatName', async () => {
    installFetch((url) => {
      if (url.includes('/channels/')) return jsonResponse({ id: '222' })
      return jsonResponse({ id: '111', name: 'Acme' })
    })
    const resolver = createDiscordChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'discord-bot', workspace: '111', chat: '222', thread: null })

    expect(result).toEqual({ workspaceName: 'Acme' })
  })

  test('caches resolved names within TTL', async () => {
    let nowVal = 1000
    installFetch((url) =>
      jsonResponse(url.includes('/channels/') ? { id: '222', name: 'general' } : { id: '111', name: 'Acme' }),
    )
    const resolver = createDiscordChannelResolver({ token: 'tok', now: () => nowVal, ttlMs: 60_000 })

    await resolver({ adapter: 'discord-bot', workspace: '111', chat: '222', thread: null })
    nowVal = 50_000
    await resolver({ adapter: 'discord-bot', workspace: '111', chat: '222', thread: null })

    expect(calls).toHaveLength(2)
  })

  test('returns empty object on total network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const resolver = createDiscordChannelResolver({ token: 'tok', now: () => 1000 })

    const result = await resolver({ adapter: 'discord-bot', workspace: '111', chat: '222', thread: null })

    expect(result).toEqual({})
  })

  test('rejects malformed IDs before building Discord API paths', async () => {
    installFetch(() => {
      throw new Error('must not fetch')
    })
    const resolver = createDiscordChannelResolver({ token: 'tok' })

    await expect(
      resolver({ adapter: 'discord-bot', workspace: '../guild', chat: 'room/1', thread: null }),
    ).resolves.toEqual({})
    expect(calls).toHaveLength(0)
  })
})
