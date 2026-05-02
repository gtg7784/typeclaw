import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'

import { DiscordIntent } from './agent-messenger-shim'
import {
  createDiscordHistoryCallback,
  createTypingCallback,
  DISCORD_BOT_INTENTS,
  DISCORD_HISTORY_LIMIT_MAX,
} from './discord-bot'

describe('discord-bot adapter (unit-level pure helpers)', () => {
  test('isAllowed denies a guild channel not in the allow list', () => {
    expect(isAllowed(['guild:1/2'], '1', '99')).toBe(false)
    expect(isAllowed(['guild:1/2'], '2', '2')).toBe(false)
  })

  test('isAllowed admits a guild channel in the allow list', () => {
    expect(isAllowed(['guild:1/2'], '1', '2')).toBe(true)
  })

  test('isAllowed admits DMs only when the rule covers @dm', () => {
    expect(isAllowed(['guild:*'], '@dm', 'd1')).toBe(false)
    expect(isAllowed(['dm:*'], '@dm', 'd1')).toBe(true)
    expect(isAllowed(['*'], '@dm', 'd1')).toBe(true)
  })
})

describe('discord-bot gateway intents', () => {
  test('includes MessageContent (privileged) so inbound messages carry text', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.MessageContent).toBe(DiscordIntent.MessageContent)
  })

  test('includes DirectMessages so DMs are delivered to the gateway', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.DirectMessages).toBe(DiscordIntent.DirectMessages)
  })

  test('includes GuildMessages so guild channel messages are delivered', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.GuildMessages).toBe(DiscordIntent.GuildMessages)
  })
})

describe('createTypingCallback', () => {
  let originalFetch: typeof fetch
  let calls: Array<{ url: string; init: RequestInit }>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('POSTs to /channels/{chat}/typing with bot token authorization', async () => {
    const cb = createTypingCallback({
      token: 'tok-abc',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/c1/typing')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot tok-abc')
  })

  test('uses thread id as the channel id when thread is set', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 'thr-9' })
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/thr-9/typing')
  })

  test('skips disallowed channels (does not call fetch)', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({
        allow: ['guild:other'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(calls).toHaveLength(0)
  })

  test('non-OK responses are logged but do not throw', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 429 })) as unknown as typeof fetch
    const warns: string[] = []
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(warns.some((m) => m.includes('429'))).toBe(true)
  })

  test('fetch rejection is swallowed and logged', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const warns: string[] = []
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(warns.some((m) => m.includes('network down'))).toBe(true)
  })

  test('rejects non-discord adapter without calling fetch', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })
    expect(calls).toHaveLength(0)
  })
})

describe('createDiscordHistoryCallback', () => {
  type FetchCall = { url: string; init: RequestInit }

  function fakeFetch(jsonOrStatus: unknown[] | { status: number }): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      if (Array.isArray(jsonOrStatus)) {
        return new Response(JSON.stringify(jsonOrStatus), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(null, { status: jsonOrStatus.status })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function permissiveConfig(): ChannelAdapterConfig {
    return { allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }
  }

  test('GETs /channels/{chat}/messages with bot token authorization', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'bot-tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'channel-id', thread: null, limit: 10 })
    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.url.startsWith('https://discord.com/api/v10/channels/channel-id/messages?')).toBe(true)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot bot-tok')
    const params = new URL(calls[0]!.url).searchParams
    expect(params.get('limit')).toBe('10')
    expect(params.get('before')).toBeNull()
  })

  test('uses args.thread as the channel id when set, falling back to args.chat otherwise', async () => {
    // given (matches the inbound classifier convention: chat = thread channel id, thread = null)
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'thread-channel-id', thread: null, limit: 10 })
    // then
    expect(calls[0]!.url.startsWith('https://discord.com/api/v10/channels/thread-channel-id/messages?')).toBe(true)

    // and given (forward-compatible: a future caller passes a non-null thread)
    const { fn: fn2, calls: calls2 } = fakeFetch([])
    const cb2 = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn2,
    })
    // when
    await cb2({ chat: 'parent-channel-id', thread: 'thread-id', limit: 10 })
    // then
    expect(calls2[0]!.url.startsWith('https://discord.com/api/v10/channels/thread-id/messages?')).toBe(true)
  })

  test('reverses Discord newest-first ordering into oldest-first', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '3',
        channel_id: 'c1',
        author: { id: 'u3', username: 'C', bot: false },
        content: 'newest',
        timestamp: '2026-04-27T00:00:03Z',
      },
      {
        id: '2',
        channel_id: 'c1',
        author: { id: 'u2', username: 'B', bot: false },
        content: 'middle',
        timestamp: '2026-04-27T00:00:02Z',
      },
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'A', bot: false },
        content: 'oldest',
        timestamp: '2026-04-27T00:00:01Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.text)).toEqual(['oldest', 'middle', 'newest'])
  })

  test('marks author.bot as isBot', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u-human', username: 'human', bot: false },
        content: 'hi',
        timestamp: '2026-04-27T00:00:01Z',
      },
      {
        id: '2',
        channel_id: 'c1',
        author: { id: 'u-bot', username: 'a-bot', bot: true },
        content: 'auto',
        timestamp: '2026-04-27T00:00:02Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const byId = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m.isBot]))
    expect(byId['1']).toBe(false)
    expect(byId['2']).toBe(true)
  })

  test('marks our own bot user id as isBot even when author.bot is missing', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u-bot' },
        content: 'self',
        timestamp: '2026-04-27T00:00:01Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => 'u-bot',
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages[0]!.isBot).toBe(true)
  })

  test('sets nextCursor to the oldest message id when the page is full', async () => {
    // given (limit=2 and exactly 2 messages returned → there may be more before)
    const { fn } = fakeFetch([
      {
        id: '5',
        channel_id: 'c1',
        author: { id: 'u', username: 'u', bot: false },
        content: 'b',
        timestamp: '2026-04-27T00:00:05Z',
      },
      {
        id: '4',
        channel_id: 'c1',
        author: { id: 'u', username: 'u', bot: false },
        content: 'a',
        timestamp: '2026-04-27T00:00:04Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 2 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBe('4')
  })

  test('omits nextCursor when the page is not full (channel start reached)', async () => {
    // given (limit=10 but only 1 message returned)
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u', username: 'u', bot: false },
        content: 'a',
        timestamp: '2026-04-27T00:00:01Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBeUndefined()
  })

  test('passes cursor through as ?before= verbatim', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'c1', thread: null, limit: 10, cursor: 'snowflake-42' })
    // then
    const params = new URL(calls[0]!.url).searchParams
    expect(params.get('before')).toBe('snowflake-42')
  })

  test('clamps limit to DISCORD_HISTORY_LIMIT_MAX', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'c1', thread: null, limit: 999 })
    // then
    const params = new URL(calls[0]!.url).searchParams
    expect(params.get('limit')).toBe(String(DISCORD_HISTORY_LIMIT_MAX))
  })

  test('returns ok:false on non-2xx response (does not throw)', async () => {
    // given
    const { fn } = fakeFetch({ status: 429 })
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'http 429' })
  })

  test('swallows fetch rejection into ok:false', async () => {
    // given
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'network down' })
  })

  test('refuses fetch when chat is not in the allow list', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: (): ChannelAdapterConfig => ({
        allow: ['guild:other-guild'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'channel-id', thread: null, limit: 10 })
    // then
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ ok: false, error: 'denied by allow rules' })
  })

  test('admits per-channel allow rule (channel:<id>) without a workspace at fetch time', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      configRef: (): ChannelAdapterConfig => ({
        allow: ['channel:channel-id'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'channel-id', thread: null, limit: 10 })
    // then
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(true)
  })
})
