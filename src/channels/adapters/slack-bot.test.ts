import { describe, expect, test } from 'bun:test'

import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'

import type { SlackSocketAppMentionEvent } from './agent-messenger-slack-shim'
import {
  createSlackHistoryCallback,
  createTypingCallback,
  promoteAppMentionToMessage,
  SLACK_HISTORY_LIMIT_MAX,
} from './slack-bot'
import { classifyInbound } from './slack-bot-classify'

describe('slack-bot adapter (unit-level pure helpers)', () => {
  test('isAllowed admits a team channel via team:T/C', () => {
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0ACME', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0ACME', 'C0OTHER')).toBe(false)
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0WIDGET', 'C0DEPLOY')).toBe(false)
  })

  test('isAllowed admits all team channels via team:*', () => {
    expect(isAllowed(['team:*'], 'T0ACME', 'C0CHANNEL')).toBe(true)
    expect(isAllowed(['team:*'], '@dm', 'D0DMID')).toBe(false)
  })

  test('isAllowed admits Slack DMs only when the rule covers @dm', () => {
    expect(isAllowed(['team:*'], '@dm', 'D0DMID')).toBe(false)
    expect(isAllowed(['im:*'], '@dm', 'D0DMID')).toBe(true)
    expect(isAllowed(['*'], '@dm', 'D0DMID')).toBe(true)
  })

  test('isAllowed admits a Slack channel by id via channel:C', () => {
    expect(isAllowed(['channel:C0DEPLOY'], 'T0ACME', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['channel:C0DEPLOY'], 'T0WIDGET', 'C0DEPLOY')).toBe(true)
  })
})

describe('slack-bot createTypingCallback', () => {
  type SetStatusCall = { channel: string; threadTs: string; status: string }

  function makeFakeClient(behavior: 'ok' | 'reject' = 'ok'): {
    client: { setAssistantStatus: (channel: string, threadTs: string, status: string) => Promise<void> }
    calls: SetStatusCall[]
  } {
    const calls: SetStatusCall[] = []
    return {
      calls,
      client: {
        setAssistantStatus: async (channel, threadTs, status) => {
          calls.push({ channel, threadTs, status })
          if (behavior === 'reject') throw new Error('channel_not_found')
        },
      },
    }
  }

  test('calls setAssistantStatus with chat + thread when target is in a thread', async () => {
    // given
    const { client, calls } = makeFakeClient()
    const cb = createTypingCallback({
      client,
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: '1700000000.000100' })
    // then
    expect(calls).toEqual([{ channel: 'C0CHANNEL', threadTs: '1700000000.000100', status: 'is typing...' }])
  })

  test('is a no-op (logs info, no API call) for top-level chats without a thread', async () => {
    // given
    const { client, calls } = makeFakeClient()
    const infos: string[] = []
    const cb = createTypingCallback({
      client,
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null })
    // then
    expect(calls).toHaveLength(0)
    expect(infos.some((m) => m.includes('top-level chat'))).toBe(true)
  })

  test('warns (does not throw) when Slack rejects the API call', async () => {
    // given
    const { client, calls } = makeFakeClient('reject')
    const warns: string[] = []
    const cb = createTypingCallback({
      client,
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: '1700000000.000100' })
    // then
    expect(calls).toHaveLength(1)
    expect(warns.some((m) => m.includes('typing') && m.includes('channel_not_found'))).toBe(true)
  })

  test('skips disallowed channels silently (no API call, no log)', async () => {
    // given
    const { client, calls } = makeFakeClient()
    const infos: string[] = []
    const warns: string[] = []
    const cb = createTypingCallback({
      client,
      configRef: () => ({
        allow: ['team:T0OTHER'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: '1700000000.000100' })
    // then
    expect(calls).toHaveLength(0)
    expect(infos).toHaveLength(0)
    expect(warns).toHaveLength(0)
  })

  test('rejects non-slack adapter without API call or logging', async () => {
    // given
    const { client, calls } = makeFakeClient()
    const infos: string[] = []
    const cb = createTypingCallback({
      client,
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'discord-bot', workspace: '1', chat: '2', thread: '3' })
    // then
    expect(calls).toHaveLength(0)
    expect(infos).toHaveLength(0)
  })
})

describe('slack-bot promoteAppMentionToMessage', () => {
  const baseAppMention: SlackSocketAppMentionEvent = {
    type: 'app_mention',
    channel: 'C0CHANNEL',
    user: 'UALICE',
    text: '<@UBOT> hi there',
    ts: '1700000000.000100',
  }

  test('produces a message-shaped event suitable for the classifier', () => {
    const promoted = promoteAppMentionToMessage(baseAppMention)

    expect(promoted.type).toBe('message')
    expect(promoted.channel).toBe('C0CHANNEL')
    expect(promoted.channel_type).toBe('channel')
    expect(promoted.user).toBe('UALICE')
    expect(promoted.text).toBe('<@UBOT> hi there')
    expect(promoted.ts).toBe('1700000000.000100')
  })

  test('preserves thread_ts when present so threaded mentions stay threaded', () => {
    const promoted = promoteAppMentionToMessage({ ...baseAppMention, thread_ts: '1699999999.000099' })

    expect(promoted.thread_ts).toBe('1699999999.000099')
  })

  test('promoted event classifies as a routed mention end-to-end', () => {
    const promoted = promoteAppMentionToMessage(baseAppMention)
    const verdict = classifyInbound(
      promoted,
      { allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true },
      { teamId: 'T0ACME', botUserId: 'UBOT' },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      chat: 'C0CHANNEL',
      isBotMention: true,
      isDm: false,
    })
  })
})

describe('createSlackHistoryCallback', () => {
  type FetchCall = { url: string; init: RequestInit }

  function fakeFetch(response: unknown): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function permissiveConfig(): ChannelAdapterConfig {
    return { allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }
  }

  test('uses conversations.replies when thread is set, with channel + ts in the body', async () => {
    // given
    const { fn, calls } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1700000000.000100', user: 'UALICE', text: 'parent', thread_ts: '1700000000.000100' },
        { ts: '1700000001.000200', user: 'UBOB', text: 'reply', thread_ts: '1700000000.000100' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'xoxb-tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => 'UBOT',
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0CHANNEL', thread: '1700000000.000100', limit: 10 })
    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://slack.com/api/conversations.replies')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer xoxb-tok')
    expect(headers['Content-Type']).toContain('application/x-www-form-urlencoded')
    const body = (calls[0]!.init.body as string) ?? ''
    const params = new URLSearchParams(body)
    expect(params.get('channel')).toBe('C0CHANNEL')
    expect(params.get('ts')).toBe('1700000000.000100')
    expect(params.get('limit')).toBe('10')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.externalMessageId)).toEqual(['1700000000.000100', '1700000001.000200'])
  })

  test('uses conversations.history when thread is null', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'xoxb-tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'C0CHANNEL', thread: null, limit: 5 })
    // then
    expect(calls[0]!.url).toBe('https://slack.com/api/conversations.history')
    const params = new URLSearchParams(calls[0]!.init.body as string)
    expect(params.get('channel')).toBe('C0CHANNEL')
    expect(params.get('ts')).toBeNull()
  })

  test('reverses conversations.history (newest-first) into oldest-first', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1700000003.000300', user: 'UC', text: 'newest' },
        { ts: '1700000002.000200', user: 'UB', text: 'middle' },
        { ts: '1700000001.000100', user: 'UA', text: 'oldest' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.text)).toEqual(['oldest', 'middle', 'newest'])
  })

  test('preserves conversations.replies order (already oldest-first)', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1700000001.000100', user: 'UA', text: 'first', thread_ts: '1700000001.000100' },
        { ts: '1700000002.000200', user: 'UB', text: 'second', thread_ts: '1700000001.000100' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: '1700000001.000100', limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.text)).toEqual(['first', 'second'])
  })

  test('marks bot_message subtype as isBot', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1.1', user: 'UALICE', text: 'human' },
        { ts: '2.2', subtype: 'bot_message', bot_id: 'B123', text: 'from a bot' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const byTs = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m.isBot]))
    expect(byTs['1.1']).toBe(false)
    expect(byTs['2.2']).toBe(true)
  })

  test('marks our own bot user id as isBot even when subtype is missing', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1.1', user: 'UBOT', text: 'self message via web api' },
        { ts: '2.2', user: 'UHUMAN', text: 'human reply' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => 'UBOT',
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const byTs = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m.isBot]))
    expect(byTs['1.1']).toBe(true)
    expect(byTs['2.2']).toBe(false)
  })

  test('exposes nextCursor when Slack returns response_metadata.next_cursor', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [{ ts: '1.1', user: 'UA', text: 'a' }],
      response_metadata: { next_cursor: 'cur-page-2' },
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBe('cur-page-2')
  })

  test('omits nextCursor when Slack returns an empty cursor', async () => {
    // given
    const { fn } = fakeFetch({ ok: true, messages: [], response_metadata: { next_cursor: '' } })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBeUndefined()
  })

  test('passes cursor through verbatim on follow-up calls', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'C0', thread: null, limit: 10, cursor: 'cur-page-2' })
    // then
    const params = new URLSearchParams(calls[0]!.init.body as string)
    expect(params.get('cursor')).toBe('cur-page-2')
  })

  test('clamps limit to SLACK_HISTORY_LIMIT_MAX', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'C0', thread: null, limit: 999 })
    // then
    const params = new URLSearchParams(calls[0]!.init.body as string)
    expect(params.get('limit')).toBe(String(SLACK_HISTORY_LIMIT_MAX))
  })

  test('returns ok:false with the slack error string when ok=false', async () => {
    // given
    const { fn } = fakeFetch({ ok: false, error: 'channel_not_found' })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'channel_not_found' })
  })

  test('swallows fetch rejection into ok:false (does not throw)', async () => {
    // given
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: permissiveConfig,
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'network down' })
  })

  test('refuses fetch when chat is not in the allow list', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: () => ({
        allow: ['team:T0OTHER'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0CHANNEL', thread: null, limit: 10 })
    // then
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ ok: false, error: 'denied by allow rules' })
  })

  test('admits per-channel allow rule (channel:C0) without a workspace at fetch time', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      configRef: (): ChannelAdapterConfig => ({
        allow: ['channel:C0CHANNEL'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      }),
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0CHANNEL', thread: null, limit: 10 })
    // then
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(true)
  })
})
