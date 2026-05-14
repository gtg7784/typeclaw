import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { DiscordBotClient, DiscordFile, DiscordMessage } from 'agent-messenger/discordbot'
import { DiscordIntent } from 'agent-messenger/discordbot'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { FetchHistoryResult, HistoryCallback, OutboundMessage } from '@/channels/types'

import {
  createDiscordHistoryCallback,
  createDiscordMembershipResolver,
  createOutboundCallback,
  createTypingCallback,
  DISCORD_BOT_INTENTS,
  DISCORD_HISTORY_LIMIT_MAX,
} from './discord-bot'

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
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, phase: 'tick' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/c1/typing')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot tok-abc')
  })

  test('uses thread id as the channel id when thread is set', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 'thr-9', phase: 'tick' })
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/thr-9/typing')
  })

  test('non-OK responses are logged but do not throw', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 429 })) as unknown as typeof fetch
    const warns: string[] = []
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, phase: 'tick' })
    expect(warns.some((m) => m.includes('429'))).toBe(true)
  })

  test('fetch rejection is swallowed and logged', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const warns: string[] = []
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, phase: 'tick' })
    expect(warns.some((m) => m.includes('network down'))).toBe(true)
  })

  test('rejects non-discord adapter without calling fetch', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null, phase: 'tick' })
    expect(calls).toHaveLength(0)
  })

  test('phase=stop is a no-op (Discord typing auto-expires; extra POST would re-arm it)', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, phase: 'stop' })
    expect(calls).toHaveLength(0)
  })
})

describe('createDiscordMembershipResolver', () => {
  type FetchCall = { url: string; init: RequestInit }
  type HistoryCall = { chat: string; thread: string | null; limit: number }

  function fakeFetch(responses: Response[]): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return responses.shift() ?? new Response(null, { status: 500 })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function fakeHistory(result: FetchHistoryResult | (() => Promise<FetchHistoryResult>)): {
    cb: HistoryCallback
    calls: HistoryCall[]
  } {
    const calls: HistoryCall[] = []
    const cb: HistoryCallback = async (args) => {
      calls.push({ chat: args.chat, thread: args.thread, limit: args.limit })
      return typeof result === 'function' ? await result() : result
    }
    return { cb, calls }
  }

  function emptyHistory(): HistoryCallback {
    return fakeHistory({ ok: true, messages: [] }).cb
  }

  test('DM short-circuits without hitting Discord or history', async () => {
    const { fn, calls } = fakeFetch([])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 42,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: '@dm', chat: 'd1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 42,
      truncated: false,
    })
    expect(calls).toHaveLength(0)
  })

  test('small guild enumerates members for an exact bot/human split', async () => {
    const { fn, calls } = fakeFetch([
      jsonResponse({ approximate_member_count: 3 }),
      jsonResponse([{ user: { id: 'u1' } }, { user: { id: 'b1', bot: true } }, { user: { id: 'u2', bot: false } }]),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
    })
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/guilds/g1/preview')
    expect(calls[1]!.url).toBe('https://discord.com/api/v10/guilds/g1/members?limit=100')
  })

  test('large guild (>cap) falls back to history-derived count', async () => {
    const { fn, calls } = fakeFetch([jsonResponse({ approximate_member_count: 75 })])
    const { cb, calls: historyCalls } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'alice',
          authorName: 'alice',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'bob',
          authorName: 'bob',
          text: 'hey',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '3',
          authorId: 'b1',
          authorName: 'b1',
          text: 'beep',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 200,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 200,
      truncated: true,
    })
    expect(calls).toHaveLength(1)
    expect(historyCalls).toEqual([{ chat: 'c1', thread: null, limit: 100 }])
  })

  test('403 from member fetch falls back to history-derived count', async () => {
    const { fn } = fakeFetch([jsonResponse({ approximate_member_count: 10 }), new Response(null, { status: 403 })])
    const { cb } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'devxoul',
          authorName: 'devxoul',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'bongbong',
          authorName: 'bongbong',
          text: 'hey',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '3',
          authorId: 'penpen',
          authorName: 'penpen',
          text: 'oi',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 300,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 2,
      fetchedAt: 300,
      truncated: true,
    })
  })

  test('403 from member fetch + history failure surfaces a transient (cache retries soon)', async () => {
    const { fn } = fakeFetch([jsonResponse({ approximate_member_count: 10 }), new Response(null, { status: 403 })])
    const { cb } = fakeHistory({ ok: false, error: 'rate-limited' })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 0,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      kind: 'transient',
    })
  })

  test('non-403 member-fetch failure propagates without falling back to history', async () => {
    const { fn } = fakeFetch([jsonResponse({ approximate_member_count: 10 }), new Response(null, { status: 500 })])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 0,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      kind: 'transient',
    })
    expect(historyCalls).toHaveLength(0)
  })

  test('403 from guild preview is a permanent resolver failure (no fallback)', async () => {
    const { fn } = fakeFetch([new Response(null, { status: 403 })])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      kind: 'permanent',
    })
    expect(historyCalls).toHaveLength(0)
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
    return {
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }
  }

  test('GETs /channels/{chat}/messages with bot token authorization', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'bot-tok',
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
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'network down' })
  })

  test('admits per-channel allow rule (channel:<id>) without a workspace at fetch time', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
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

describe('discord-bot createOutboundCallback', () => {
  type SendCall = { chat: string; content: string; options?: { thread_id?: string } }
  type UploadCall = { chat: string; path: string }

  function makeFakeClient(
    behavior: {
      sendMessage?: 'ok' | 'reject'
      uploadFile?: 'ok' | 'reject'
    } = {},
  ): {
    client: Pick<DiscordBotClient, 'sendMessage' | 'uploadFile'>
    sends: SendCall[]
    uploads: UploadCall[]
  } {
    const sends: SendCall[] = []
    const uploads: UploadCall[] = []
    return {
      sends,
      uploads,
      client: {
        sendMessage: async (chat, content, options) => {
          sends.push({ chat, content, options })
          if (behavior.sendMessage === 'reject') throw new Error('discord_send_failed')
          return {
            id: `m${sends.length}`,
            channel_id: chat,
            author: { id: 'b1', username: 'bot' },
            content,
            timestamp: '',
          } as DiscordMessage
        },
        uploadFile: async (chat, path) => {
          uploads.push({ chat, path })
          if (behavior.uploadFile === 'reject') throw new Error('discord_upload_failed')
          const filename = path.split('/').pop() ?? 'file'
          return { id: `f${uploads.length}`, filename, size: 12, url: `https://cdn.example/${filename}` } as DiscordFile
        },
      },
    }
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function permissive(): ChannelAdapterConfig {
    return {
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }
  }

  function makeMsg(overrides: Partial<OutboundMessage>): OutboundMessage {
    return { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hi', ...overrides } as OutboundMessage
  }

  const tag = async (_w: string, _c: string) => 'guild=g1 channel=c1'

  test('text-only path posts via sendMessage and never calls uploadFile', async () => {
    // given
    const { client, sends, uploads } = makeFakeClient()
    const cb = createOutboundCallback({ client, logger: silentLogger(), formatChannelTag: tag })
    // when
    const result = await cb(makeMsg({ text: 'hello' }))
    // then
    expect(result.ok).toBe(true)
    expect(uploads).toHaveLength(0)
    expect(sends).toEqual([{ chat: 'c1', content: 'hello', options: undefined }])
  })

  test('threaded text-only post forwards thread_id to sendMessage', async () => {
    const { client, sends } = makeFakeClient()
    const cb = createOutboundCallback({ client, logger: silentLogger(), formatChannelTag: tag })
    await cb(makeMsg({ text: 'hello', thread: 't1' }))
    expect(sends).toEqual([{ chat: 'c1', content: 'hello', options: { thread_id: 't1' } }])
  })

  test('attachments-only post uploads each file with no follow-up sendMessage', async () => {
    const { client, sends, uploads } = makeFakeClient()
    const cb = createOutboundCallback({ client, logger: silentLogger(), formatChannelTag: tag })
    const result = await cb(
      makeMsg({ text: undefined, attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }] }),
    )
    expect(result.ok).toBe(true)
    expect(uploads).toEqual([
      { chat: 'c1', path: '/agent/a.png' },
      { chat: 'c1', path: '/agent/b.pdf' },
    ])
    expect(sends).toHaveLength(0)
  })

  test('text+attachments uploads first, then posts text in same channel', async () => {
    // given
    const { client, sends, uploads } = makeFakeClient()
    const order: string[] = []
    const recordingClient = {
      sendMessage: async (...args: Parameters<DiscordBotClient['sendMessage']>) => {
        order.push('send')
        return client.sendMessage(...args)
      },
      uploadFile: async (...args: Parameters<DiscordBotClient['uploadFile']>) => {
        order.push('upload')
        return client.uploadFile(...args)
      },
    }
    const cb = createOutboundCallback({
      client: recordingClient,
      logger: silentLogger(),
      formatChannelTag: tag,
    })
    // when
    await cb(makeMsg({ text: 'caption', attachments: [{ path: '/agent/a.png' }] }))
    // then
    expect(order).toEqual(['upload', 'send'])
    expect(uploads).toEqual([{ chat: 'c1', path: '/agent/a.png' }])
    expect(sends).toEqual([{ chat: 'c1', content: 'caption', options: undefined }])
  })

  test('threaded text+attachments warns about file landing in channel root and still threads the text', async () => {
    // given
    const { client, sends } = makeFakeClient()
    const warns: string[] = []
    const cb = createOutboundCallback({
      client,
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
      formatChannelTag: tag,
    })
    // when
    await cb(makeMsg({ text: 'caption', thread: 't1', attachments: [{ path: '/agent/a.png' }] }))
    // then
    expect(sends).toEqual([{ chat: 'c1', content: 'caption', options: { thread_id: 't1' } }])
    expect(warns.some((m) => m.includes('channel root, not thread t1'))).toBe(true)
  })

  test('upload failure aborts before sendMessage runs', async () => {
    const { client, sends } = makeFakeClient({ uploadFile: 'reject' })
    const cb = createOutboundCallback({ client, logger: silentLogger(), formatChannelTag: tag })
    const result = await cb(makeMsg({ text: 'caption', attachments: [{ path: '/agent/a.png' }] }))
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error : '').toContain('uploadFile failed')
    expect(sends).toHaveLength(0)
  })

  test('rejects when message has neither text nor attachments', async () => {
    const { client } = makeFakeClient()
    const cb = createOutboundCallback({ client, logger: silentLogger(), formatChannelTag: tag })
    const result = await cb(makeMsg({ text: undefined, attachments: [] }))
    expect(result.ok).toBe(false)
  })

  test('honors resolvePath for sandboxed-path translation before uploading', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      resolvePath: (p) => p.replace('/agent/', '/host/mounts/agent/'),
    })
    await cb(makeMsg({ text: undefined, attachments: [{ path: '/agent/a.png' }] }))
    expect(uploads).toEqual([{ chat: 'c1', path: '/host/mounts/agent/a.png' }])
  })
})
