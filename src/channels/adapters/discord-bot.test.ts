import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { DiscordBotClient, DiscordFile, DiscordMessage } from 'agent-messenger/discordbot'
import { DiscordIntent } from 'agent-messenger/discordbot'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { FetchHistoryResult, HistoryCallback, OutboundMessage } from '@/channels/types'
import type { ChannelKey } from '@/channels/types'

import {
  createDiscordHistoryCallback,
  createDiscordMembershipResolver,
  createInteractionHandler,
  createOutboundCallback,
  createTypingCallback,
  DISCORD_BOT_INTENTS,
  DISCORD_HISTORY_LIMIT_MAX,
  DISCORD_SLASH_COMMAND_NAMES,
} from './discord-bot'
import { DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT } from './discord-bot-slash-commands'

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

  // A fully public channel: @everyone can VIEW_CHANNEL (no deny overwrite),
  // so the channel-scoped count equals the guild count. Members carry no roles
  // beyond @everyone; the guild's @everyone role grants VIEW_CHANNEL (0x400).
  function publicChannelGuild(): { channel: unknown; guild: unknown } {
    return {
      channel: { type: 0, permission_overwrites: [] },
      guild: { owner_id: 'owner', roles: [{ id: 'g1', permissions: String(0x400) }] },
    }
  }

  test('small guild enumerates members for an exact bot/human split (public channel)', async () => {
    const { fn, calls } = fakeFetch([
      jsonResponse({ approximate_member_count: 3 }),
      jsonResponse([{ user: { id: 'u1' } }, { user: { id: 'b1', bot: true } }, { user: { id: 'u2', bot: false } }]),
      jsonResponse(publicChannelGuild().channel),
      jsonResponse(publicChannelGuild().guild),
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
      humanMemberIds: ['u1', 'u2'],
    })
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/guilds/g1/preview')
    expect(calls[1]!.url).toBe('https://discord.com/api/v10/guilds/g1/members?limit=100')
    const scopedUrls = calls.slice(2).map((c) => c.url)
    expect(scopedUrls).toContain('https://discord.com/api/v10/channels/c1')
    expect(scopedUrls).toContain('https://discord.com/api/v10/guilds/g1')
  })

  test('scopes visibility to key.thread when set, not the parent key.chat', async () => {
    // given a forward-compatible key shape (chat = parent, thread = thread id);
    // visibility must be evaluated against the thread channel, not the parent.
    const { fn, calls } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([
        { user: { id: 'u1', bot: false }, roles: [] },
        { user: { id: 'b1', bot: true }, roles: [] },
      ]),
      jsonResponse(publicChannelGuild().channel),
      jsonResponse(publicChannelGuild().guild),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    // when the inbound is anchored at a thread
    await expect(
      resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'parent-c1', thread: 'thread-t9' }),
    ).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
      humanMemberIds: ['u1'],
    })

    // then the channel object fetched is the thread, not the parent
    const scopedUrls = calls.slice(2).map((c) => c.url)
    expect(scopedUrls).toContain('https://discord.com/api/v10/channels/thread-t9')
    expect(scopedUrls).not.toContain('https://discord.com/api/v10/channels/parent-c1')
  })

  test('private channel: @everyone denied VIEW_CHANNEL, only the agent bot allowed → bots:1, humans:1', async () => {
    // given: the exact production shape — guild has 1 human (owner) + 3 bots,
    // but #typeey denies @everyone VIEW_CHANNEL (0x400) and allows only the
    // agent's own bot. The owner (human) bypasses overwrites; the two peer
    // bots have no allow overwrite, so they are not channel-visible.
    const VIEW = 0x400
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 4 }),
      jsonResponse([
        { user: { id: 'owner', bot: false }, roles: [] },
        { user: { id: 'peerbotA', bot: true }, roles: [] },
        { user: { id: 'agentbot', bot: true }, roles: [] },
        { user: { id: 'peerbotB', bot: true }, roles: [] },
      ]),
      jsonResponse({
        type: 0,
        permission_overwrites: [
          { id: 'g1', type: 0, allow: '0', deny: String(VIEW) },
          { id: 'agentbot', type: 1, allow: String(VIEW), deny: '0' },
        ],
      }),
      jsonResponse({ owner_id: 'owner', roles: [{ id: 'g1', permissions: '0' }] }),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    // then: only owner (human) + agentbot (bot) are visible → the single-human
    // grant_role relaxation can fire.
    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
      humanMemberIds: ['owner'],
    })
  })

  test('ADMINISTRATOR role bypasses a channel deny overwrite', async () => {
    const VIEW = 0x400
    const ADMIN = 0x8
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([
        { user: { id: 'admin', bot: false }, roles: ['adminRole'] },
        { user: { id: 'agentbot', bot: true }, roles: [] },
      ]),
      jsonResponse({
        type: 0,
        permission_overwrites: [
          { id: 'g1', type: 0, allow: '0', deny: String(VIEW) },
          { id: 'agentbot', type: 1, allow: String(VIEW), deny: '0' },
        ],
      }),
      jsonResponse({
        owner_id: 'someone-else',
        roles: [
          { id: 'g1', permissions: '0' },
          { id: 'adminRole', permissions: String(ADMIN) },
        ],
      }),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
      humanMemberIds: ['admin'],
    })
  })

  test('a member referencing an unknown role fails closed to history fallback', async () => {
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([{ user: { id: 'u1', bot: false }, roles: ['ghostRole'] }]),
      jsonResponse({ type: 0, permission_overwrites: [] }),
      jsonResponse({ owner_id: 'owner', roles: [{ id: 'g1', permissions: String(0x400) }] }),
    ])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 0,
      bots: 0,
      fetchedAt: 100,
      truncated: true,
    })
    expect(historyCalls).toHaveLength(1)
  })

  test('a thread channel fails closed to history fallback (visibility not modelled)', async () => {
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 3 }),
      jsonResponse([{ user: { id: 'u1', bot: false }, roles: [] }]),
      jsonResponse({ type: 11, permission_overwrites: [] }),
      jsonResponse({ owner_id: 'owner', roles: [{ id: 'g1', permissions: String(0x400) }] }),
    ])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 0,
      bots: 0,
      fetchedAt: 100,
      truncated: true,
    })
    expect(historyCalls).toHaveLength(1)
  })

  test('channel fetch failure fails closed to history fallback', async () => {
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([{ user: { id: 'u1', bot: false }, roles: [] }]),
      new Response(null, { status: 403 }),
      jsonResponse({ owner_id: 'owner', roles: [{ id: 'g1', permissions: String(0x400) }] }),
    ])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 0,
      bots: 0,
      fetchedAt: 100,
      truncated: true,
    })
    expect(historyCalls).toHaveLength(1)
  })

  test('an unidentifiable visible human drops humanMemberIds (counts-only)', async () => {
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([
        { user: { bot: false }, roles: [] },
        { user: { id: 'b1', bot: true }, roles: [] },
      ]),
      jsonResponse(publicChannelGuild().channel),
      jsonResponse(publicChannelGuild().guild),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
    })
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
          authorId: 'alice',
          authorName: 'alice',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'toto',
          authorName: 'toto',
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

  test('maps attachments on history messages into attachments and bakes placeholders into text', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'A', bot: false },
        content: 'what is this?',
        timestamp: '2026-04-27T00:00:01Z',
        attachments: [{ url: 'https://cdn.example/photo.png', filename: 'photo.png', content_type: 'image/png' }],
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
    const msg = result.messages[0]!
    expect(msg.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'https://cdn.example/photo.png', filename: 'photo.png', mimetype: 'image/png' },
    ])
    expect(msg.text).toBe('what is this?\n[Discord attachment #1: file image/png name=photo.png]')
  })

  test('omits attachments and leaves text untouched when a history message has no media', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'A', bot: false },
        content: 'plain text',
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
    const msg = result.messages[0]!
    expect(msg.attachments).toBeUndefined()
    expect(msg.text).toBe('plain text')
  })

  test('renders media-only history message (no text) as placeholder-only text and numbers across media kinds', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'A', bot: false },
        content: '',
        timestamp: '2026-04-27T00:00:01Z',
        attachments: [{ url: 'https://cdn.example/a.jpg', filename: 'a.jpg', content_type: 'image/jpeg' }],
        sticker_items: [{ id: 's1', name: 'wave', format_type: 1 }],
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
    const msg = result.messages[0]!
    expect(msg.text).toBe(
      '[Discord attachment #1: file image/jpeg name=a.jpg]\n[Discord attachment #2: sticker name=wave]',
    )
    expect(msg.attachments).toHaveLength(2)
    expect(msg.attachments!.map((a) => a.id)).toEqual([1, 2])
  })

  test('resolves a thread-starter (empty body + referenced_message) to the opener author and text', async () => {
    // given: Discord returns the type-21 starter with empty content/bot author;
    // the real opener lives only in referenced_message
    const { fn } = fakeFetch([
      {
        id: 'starter-1',
        channel_id: 'thread-t1',
        type: 21,
        author: { id: 'system-bot', username: 'Discord', bot: true },
        content: '',
        timestamp: '2026-04-27T00:00:01Z',
        message_reference: { message_id: 'opener-1', channel_id: 'parent-c1' },
        referenced_message: {
          id: 'opener-1',
          channel_id: 'parent-c1',
          author: { id: 'u-human', username: 'alice', global_name: 'Alice', bot: false },
          content: 'the question that started the thread',
          timestamp: '2026-04-26T23:59:00Z',
        },
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'thread-t1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe('the question that started the thread')
    expect(msg.authorId).toBe('u-human')
    expect(msg.authorName).toBe('Alice')
    expect(msg.isBot).toBe(false)
    // keeps the starter's own id/ts so dedup and ordering stay correct
    expect(msg.externalMessageId).toBe('starter-1')
    expect(msg.ts).toBe(Date.parse('2026-04-27T00:00:01Z'))
  })

  test('carries the opener attachments when a thread-starter opener has media but no text', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: 'starter-1',
        channel_id: 'thread-t1',
        type: 21,
        author: { id: 'system-bot', username: 'Discord', bot: true },
        content: '',
        timestamp: '2026-04-27T00:00:01Z',
        message_reference: { message_id: 'opener-1', channel_id: 'parent-c1' },
        referenced_message: {
          id: 'opener-1',
          channel_id: 'parent-c1',
          author: { id: 'u-human', username: 'alice', bot: false },
          content: '',
          timestamp: '2026-04-26T23:59:00Z',
          attachments: [{ url: 'https://cdn.example/p.png', filename: 'p.png', content_type: 'image/png' }],
        },
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'thread-t1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe('[Discord attachment #1: file image/png name=p.png]')
    expect(msg.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'https://cdn.example/p.png', filename: 'p.png', mimetype: 'image/png' },
    ])
    expect(msg.authorId).toBe('u-human')
  })

  test('keeps the starter own body when it has content (does not override with referenced_message)', async () => {
    // given: a normal reply (type 19) carries both its own content and a referenced_message
    const { fn } = fakeFetch([
      {
        id: 'reply-1',
        channel_id: 'c1',
        type: 19,
        author: { id: 'u-bob', username: 'bob', bot: false },
        content: 'my reply text',
        timestamp: '2026-04-27T00:00:02Z',
        message_reference: { message_id: 'orig-1', channel_id: 'c1' },
        referenced_message: {
          id: 'orig-1',
          channel_id: 'c1',
          author: { id: 'u-alice', username: 'alice', bot: false },
          content: 'the original',
          timestamp: '2026-04-27T00:00:01Z',
        },
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
    const msg = result.messages[0]!
    expect(msg.text).toBe('my reply text')
    expect(msg.authorId).toBe('u-bob')
    expect(msg.replyToBotMessageId).toBe('orig-1')
  })

  test('does NOT remap an empty-body non-starter (type 19/23) carrying referenced_message', async () => {
    // given: an empty-body REPLY (19) and CONTEXT_MENU_COMMAND (23) both carry
    // referenced_message but are not thread starters; they must stay attributed
    // to their own author, never the referenced message's
    const { fn } = fakeFetch([
      {
        id: 'reply-1',
        channel_id: 'c1',
        type: 19,
        author: { id: 'u-bob', username: 'bob', bot: false },
        content: '',
        timestamp: '2026-04-27T00:00:02Z',
        message_reference: { message_id: 'orig-1', channel_id: 'c1' },
        referenced_message: {
          id: 'orig-1',
          channel_id: 'c1',
          author: { id: 'u-alice', username: 'alice', bot: false },
          content: 'the original',
          timestamp: '2026-04-27T00:00:01Z',
        },
      },
      {
        id: 'ctx-1',
        channel_id: 'c1',
        type: 23,
        author: { id: 'u-carol', username: 'carol', bot: false },
        content: '',
        timestamp: '2026-04-27T00:00:03Z',
        message_reference: { message_id: 'orig-1', channel_id: 'c1' },
        referenced_message: {
          id: 'orig-1',
          channel_id: 'c1',
          author: { id: 'u-alice', username: 'alice', bot: false },
          content: 'the original',
          timestamp: '2026-04-27T00:00:01Z',
        },
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
    const byId = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m]))
    expect(byId['reply-1']!.authorId).toBe('u-bob')
    expect(byId['reply-1']!.text).toBe('')
    expect(byId['ctx-1']!.authorId).toBe('u-carol')
    expect(byId['ctx-1']!.text).toBe('')
  })

  test('leaves an empty-body starter untouched when referenced_message is null (opener deleted)', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: 'starter-1',
        channel_id: 'thread-t1',
        type: 21,
        author: { id: 'system-bot', username: 'Discord', bot: true },
        content: '',
        timestamp: '2026-04-27T00:00:01Z',
        message_reference: { message_id: 'opener-1', channel_id: 'parent-c1' },
        referenced_message: null,
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'thread-t1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe('')
    expect(msg.authorId).toBe('system-bot')
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
  type SendCall = { chat: string; content: string; options?: { thread_id?: string; reply_to?: string } }
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

  test('forwards replyTo.externalMessageId as the reply_to send option (native reply)', async () => {
    const { client, sends } = makeFakeClient()
    const cb = createOutboundCallback({ client, logger: silentLogger(), formatChannelTag: tag })
    await cb(makeMsg({ text: 'on it', replyTo: { externalMessageId: 'parent-9' } }))
    expect(sends).toEqual([{ chat: 'c1', content: 'on it', options: { reply_to: 'parent-9' } }])
  })

  test('combines thread_id and reply_to when both apply', async () => {
    const { client, sends } = makeFakeClient()
    const cb = createOutboundCallback({ client, logger: silentLogger(), formatChannelTag: tag })
    await cb(makeMsg({ text: 'on it', thread: 't1', replyTo: { externalMessageId: 'parent-9' } }))
    expect(sends).toEqual([{ chat: 'c1', content: 'on it', options: { thread_id: 't1', reply_to: 'parent-9' } }])
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

describe('discord-bot slash command declarations', () => {
  test('declares help, stop, reload, and restart', () => {
    expect(DISCORD_SLASH_COMMAND_NAMES).toEqual(new Set(['help', 'stop', 'reload', 'restart']))
  })
})

describe('createInteractionHandler', () => {
  type CapturedCall = { url: string; init: RequestInit }
  type RouterCall = { key: ChannelKey; name: string; invokerId: string }
  type RouterResult =
    | { kind: 'handled'; name: string; reply?: string }
    | { kind: 'no-live-session' }
    | { kind: 'permission-denied' }
    | { kind: 'unknown-command'; name: string }

  function setup(
    routerImpl: (key: ChannelKey, name: string, invokerId: string) => Promise<RouterResult>,
    formatChannelTagImpl?: (workspace: string, chat: string) => Promise<string>,
  ): {
    handler: ReturnType<typeof createInteractionHandler>
    fetchCalls: CapturedCall[]
    routerCalls: RouterCall[]
    logs: { info: string[]; warn: string[]; error: string[] }
  } {
    const fetchCalls: CapturedCall[] = []
    const routerCalls: RouterCall[] = []
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const fetchImpl = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      return new Response('', { status: 204 })
    }) as unknown as typeof fetch
    const handler = createInteractionHandler({
      router: {
        executeCommand: async (key, name, options) => {
          routerCalls.push({ key, name, invokerId: options.invokerId })
          return routerImpl(key, name, options.invokerId)
        },
      },
      knownCommandNames: DISCORD_SLASH_COMMAND_NAMES,
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
      formatChannelTag: formatChannelTagImpl ?? (async (workspace, chat) => `guild=${workspace} channel=${chat}`),
      fetchImpl,
    })
    return { handler, fetchCalls, routerCalls, logs }
  }

  function interaction(over: Record<string, unknown> = {}): Parameters<ReturnType<typeof createInteractionHandler>>[0] {
    return {
      type: 'INTERACTION_CREATE',
      id: 'i-1',
      application_id: 'app-1',
      token: 'tok-abc',
      channel_id: 'c1',
      guild_id: 'g1',
      member: { user: { id: 'u-alice' } },
      data: { name: 'stop', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT },
      ...over,
    } as Parameters<ReturnType<typeof createInteractionHandler>>[0]
  }

  test('/stop interaction routes to executeCommand with the correct ChannelKey, forwards the invoker, and acks Discord', async () => {
    const { handler, fetchCalls, routerCalls } = setup(async () => ({ kind: 'handled', name: 'stop' }))

    await handler(interaction())

    expect(routerCalls).toEqual([
      {
        key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null },
        name: 'stop',
        invokerId: 'u-alice',
      },
    ])
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('https://discord.com/api/v10/interactions/i-1/tok-abc/callback')
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.data.content).toContain('Stopped')
    expect(body.data.flags).toBe(64)
  })

  test('/help interaction acks with the handler-provided command list', async () => {
    const helpText = 'Available commands:\n/help — List available commands\n/stop — Abort the current turn'
    const { handler, fetchCalls } = setup(async () => ({ kind: 'handled', name: 'help', reply: helpText }))

    await handler(interaction({ data: { name: 'help', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT } }))

    expect(fetchCalls).toHaveLength(1)
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.data.content).toBe(helpText)
    expect(body.data.flags).toBe(64)
  })

  test('cold-channel /stop acks with "nothing to stop" and does not retry', async () => {
    const { handler, fetchCalls, routerCalls } = setup(async () => ({ kind: 'no-live-session' }))

    await handler(interaction())

    expect(routerCalls).toHaveLength(1)
    expect(fetchCalls).toHaveLength(1)
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.data.content).toContain('Nothing to stop')
  })

  test('non-CHAT_INPUT interactions (buttons, modals, autocomplete) are silently dropped', async () => {
    const { handler, fetchCalls, routerCalls, logs } = setup(async () => ({ kind: 'handled', name: 'stop' }))

    await handler(interaction({ data: { name: 'stop', type: 2 } }))

    expect(routerCalls).toEqual([])
    expect(fetchCalls).toEqual([])
    expect(logs.warn).toEqual([])
  })

  test('unknown registered command name is dropped with a warn log (defensive)', async () => {
    const { handler, fetchCalls, routerCalls, logs } = setup(async () => ({ kind: 'handled', name: 'stop' }))

    await handler(interaction({ data: { name: 'totally-not-stop', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT } }))

    expect(routerCalls).toEqual([])
    expect(fetchCalls).toEqual([])
    expect(logs.warn.some((m) => m.includes('unknown-command'))).toBe(true)
  })

  test('DM interaction (no guild) maps workspace to @dm and resolves invoker from user.id', async () => {
    const { handler, routerCalls } = setup(async () => ({ kind: 'handled', name: 'stop' }))

    await handler(
      interaction({
        guild_id: undefined,
        member: undefined,
        user: { id: 'u-bob', username: 'bob' },
      }),
    )

    expect(routerCalls).toEqual([
      {
        key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
        name: 'stop',
        invokerId: 'u-bob',
      },
    ])
  })

  test('ack failure is logged but does not throw (abort already happened server-side)', async () => {
    const fetchCalls: CapturedCall[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      return new Response('{"message":"Unknown interaction"}', { status: 404 })
    }) as unknown as typeof fetch
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const handler = createInteractionHandler({
      router: { executeCommand: async () => ({ kind: 'handled', name: 'stop' }) },
      knownCommandNames: DISCORD_SLASH_COMMAND_NAMES,
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
      formatChannelTag: async () => 'guild=g1 channel=c1',
      fetchImpl,
    })

    await handler(interaction())

    expect(logs.warn.some((m) => m.includes('ack failed'))).toBe(true)
    expect(logs.error).toEqual([])
  })

  test('exception inside executeCommand is caught and logged as error', async () => {
    const { handler, logs } = setup(async () => {
      throw new Error('router exploded')
    })

    await handler(interaction())

    expect(logs.error.some((m) => m.includes('router exploded'))).toBe(true)
  })

  test('permission-denied result acks with the permission-denied message (visible to invoker)', async () => {
    const { handler, fetchCalls } = setup(async () => ({ kind: 'permission-denied' }))

    await handler(interaction())

    expect(fetchCalls).toHaveLength(1)
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.data.content).toMatch(/permission/i)
    expect(body.data.flags).toBe(64)
  })

  test('ack is sent BEFORE the slow formatChannelTag completes (3s budget protection)', async () => {
    // Fixed clock — measure when ack is sent relative to formatChannelTag.
    const events: Array<{ at: number; kind: 'router-call' | 'ack-sent' | 'channel-tag-resolved' }> = []
    let clock = 0
    const tick = (): number => ++clock

    const fetchCalls: CapturedCall[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      events.push({ at: tick(), kind: 'ack-sent' })
      return new Response('', { status: 204 })
    }) as unknown as typeof fetch

    let releaseTag: (() => void) | undefined
    const tagPromise = new Promise<string>((resolve) => {
      releaseTag = () => {
        events.push({ at: tick(), kind: 'channel-tag-resolved' })
        resolve('guild=g1-name channel=c1-name')
      }
    })

    const handler = createInteractionHandler({
      router: {
        executeCommand: async () => {
          events.push({ at: tick(), kind: 'router-call' })
          return { kind: 'handled', name: 'stop' }
        },
      },
      knownCommandNames: DISCORD_SLASH_COMMAND_NAMES,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      formatChannelTag: () => tagPromise,
      fetchImpl,
    })

    const handlerDone = handler(interaction())
    // Wait long enough for router.executeCommand and ack to complete, but
    // hold formatChannelTag back. If the ack-first ordering is correct, the
    // ack already fired before we release the tag.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fetchCalls).toHaveLength(1)
    expect(events.map((e) => e.kind)).toEqual(['router-call', 'ack-sent'])

    releaseTag!()
    await handlerDone

    expect(events.map((e) => e.kind)).toEqual(['router-call', 'ack-sent', 'channel-tag-resolved'])
  })
})
