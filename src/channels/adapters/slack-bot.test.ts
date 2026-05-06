import { describe, expect, test } from 'bun:test'

import { defaultHistoryConfig, isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type { FetchHistoryResult, HistoryCallback, OutboundMessage } from '@/channels/types'

import type {
  SlackBotClient,
  SlackFile,
  SlackPostedMessage,
  SlackSocketAppMentionEvent,
} from './agent-messenger-slack-shim'
import {
  createOutboundCallback,
  createSlackHistoryCallback,
  createSlackMembershipResolver,
  createSlackTypingTracker,
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

  function makeFakeTracker(behavior: 'ok' | 'reject' = 'ok'): {
    tracker: {
      setStatus: (chat: string, threadTs: string, status: string) => Promise<void>
      clearAfterSend: () => Promise<void>
    }
    calls: SetStatusCall[]
  } {
    const calls: SetStatusCall[] = []
    return {
      calls,
      tracker: {
        setStatus: async (channel, threadTs, status) => {
          calls.push({ channel, threadTs, status })
          if (behavior === 'reject') throw new Error('channel_not_found')
        },
        clearAfterSend: async () => {},
      },
    }
  }

  test('calls tracker.setStatus with chat + thread when target is in a thread', async () => {
    // given
    const { tracker, calls } = makeFakeTracker()
    const cb = createTypingCallback({
      typingTracker: tracker,
      configRef: () => ({
        allow: ['*'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: '1700000000.000100' })
    // then
    expect(calls).toEqual([{ channel: 'C0CHANNEL', threadTs: '1700000000.000100', status: 'is typing...' }])
  })

  test('is a no-op (logs info, no API call) for top-level chats without a thread', async () => {
    // given
    const { tracker, calls } = makeFakeTracker()
    const infos: string[] = []
    const cb = createTypingCallback({
      typingTracker: tracker,
      configRef: () => ({
        allow: ['*'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      }),
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
    const calls: SetStatusCall[] = []
    const warns: string[] = []
    const tracker = createSlackTypingTracker({
      client: {
        setAssistantStatus: async (channel, threadTs, status) => {
          calls.push({ channel, threadTs, status })
          throw new Error('channel_not_found')
        },
      },
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    const cb = createTypingCallback({
      typingTracker: tracker,
      configRef: () => ({
        allow: ['*'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      }),
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
    const { tracker, calls } = makeFakeTracker()
    const infos: string[] = []
    const warns: string[] = []
    const cb = createTypingCallback({
      typingTracker: tracker,
      configRef: () => ({
        allow: ['team:T0OTHER'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
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
    const { tracker, calls } = makeFakeTracker()
    const infos: string[] = []
    const cb = createTypingCallback({
      typingTracker: tracker,
      configRef: () => ({
        allow: ['*'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      }),
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'discord-bot', workspace: '1', chat: '2', thread: '3' })
    // then
    expect(calls).toHaveLength(0)
    expect(infos).toHaveLength(0)
  })
})

describe('createSlackTypingTracker', () => {
  type SetStatusCall = { channel: string; threadTs: string; status: string }

  function makeDeferredClient(): {
    client: { setAssistantStatus: (channel: string, threadTs: string, status: string) => Promise<void> }
    calls: SetStatusCall[]
    pending: Array<{ resolve: () => void; reject: (err: Error) => void }>
    settledOrder: string[]
  } {
    const calls: SetStatusCall[] = []
    const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
    const settledOrder: string[] = []
    return {
      calls,
      pending,
      settledOrder,
      client: {
        setAssistantStatus: (channel, threadTs, status) => {
          calls.push({ channel, threadTs, status })
          const idx = calls.length - 1
          return new Promise<void>((resolve, reject) => {
            pending.push({
              resolve: () => {
                settledOrder.push(`${idx}:${status}`)
                resolve()
              },
              reject,
            })
          })
        },
      },
    }
  }

  // Flush all pending microtasks so chained `.then()` continuations run
  // before the next assertion. The tracker queues calls via promise
  // chaining, so the first client call is reached on the next microtask
  // tick rather than synchronously.
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  test('serializes calls per (chat, thread) so an explicit clear lands AFTER an in-flight typing call', async () => {
    // given
    const { client, pending, settledOrder } = makeDeferredClient()
    const tracker = createSlackTypingTracker({
      client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    const typingPromise = tracker.setStatus('C0', 'T0', 'is typing...')
    const clearPromise = tracker.clearAfterSend('C0', 'T0')
    await flushMicrotasks()
    expect(pending).toHaveLength(1)
    pending[0]!.resolve()
    await typingPromise
    await flushMicrotasks()
    expect(pending).toHaveLength(2)
    pending[1]!.resolve()
    await clearPromise
    // then
    expect(settledOrder).toEqual(['0:is typing...', '1:'])
  })

  test('does not block calls for a different (chat, thread) pair', async () => {
    // given
    const { client, pending } = makeDeferredClient()
    const tracker = createSlackTypingTracker({
      client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const a = tracker.setStatus('C0', 'T0', 'is typing...')
    // when
    const b = tracker.setStatus('C0', 'T1', 'is typing...')
    const c = tracker.setStatus('C1', 'T0', 'is typing...')
    await flushMicrotasks()
    // then
    expect(pending).toHaveLength(3)
    pending[0]!.resolve()
    pending[1]!.resolve()
    pending[2]!.resolve()
    await Promise.all([a, b, c])
  })

  test('clearAfterSend with no thread is a no-op (top-level chats have no typing indicator)', async () => {
    const { client, calls } = makeDeferredClient()
    const tracker = createSlackTypingTracker({
      client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await tracker.clearAfterSend('C0', null)
    await tracker.clearAfterSend('C0', undefined)
    await tracker.clearAfterSend('C0', '')
    expect(calls).toHaveLength(0)
  })

  test('a failing typing call does not poison the queue for the next call', async () => {
    // given
    const { client, pending } = makeDeferredClient()
    const warns: string[] = []
    const tracker = createSlackTypingTracker({
      client,
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    const first = tracker.setStatus('C0', 'T0', 'is typing...')
    const second = tracker.clearAfterSend('C0', 'T0')
    await flushMicrotasks()
    expect(pending).toHaveLength(1)
    pending[0]!.reject(new Error('channel_not_found'))
    await first
    await flushMicrotasks()
    // when
    expect(pending).toHaveLength(2)
    pending[1]!.resolve()
    await second
    // then
    expect(warns.some((m) => m.includes('channel_not_found'))).toBe(true)
  })
})

describe('createSlackMembershipResolver', () => {
  type FetchCall = { url: string; init: RequestInit }
  type HistoryCall = { chat: string; thread: string | null; limit: number }

  function fakeFetch(responses: Response[]): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return responses.shift() ?? slackResponse({ ok: false, error: 'rate_limited' })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  function slackResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
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

  test('DM short-circuits without hitting Slack or history', async () => {
    const { fn, calls } = fakeFetch([])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 10,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: '@dm', chat: 'D1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 10,
      truncated: false,
    })
    expect(calls).toHaveLength(0)
  })

  test('small channel enumerates members and classifies bots with users.info', async () => {
    const { fn, calls } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 3 } }),
      slackResponse({ ok: true, members: ['U1', 'B1', 'U2'] }),
      slackResponse({ ok: true, user: { is_bot: false } }),
      slackResponse({ ok: true, user: { is_bot: true } }),
      slackResponse({ ok: true, user: { is_bot: false } }),
    ])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 20,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 20,
      truncated: false,
    })
    expect(calls.map((c) => c.url)).toEqual([
      'https://slack.com/api/conversations.info',
      'https://slack.com/api/conversations.members',
      'https://slack.com/api/users.info',
      'https://slack.com/api/users.info',
      'https://slack.com/api/users.info',
    ])
  })

  test('large channel (>cap) falls back to history-derived count', async () => {
    const { fn, calls } = fakeFetch([slackResponse({ ok: true, channel: { num_members: 80 } })])
    const { cb, calls: historyCalls } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'UALICE',
          authorName: 'alice',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'BBOT',
          authorName: 'bot',
          text: 'beep',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 30,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 30,
      truncated: true,
    })
    expect(calls).toHaveLength(1)
    expect(historyCalls).toEqual([{ chat: 'C1', thread: null, limit: 100 }])
  })

  test('missing_scope on conversations.info falls back to history-derived count', async () => {
    const { fn } = fakeFetch([slackResponse({ ok: false, error: 'missing_scope' })])
    const { cb } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'UALICE',
          authorName: 'alice',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 40,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 0,
      fetchedAt: 40,
      truncated: true,
    })
  })

  test('not_in_channel on conversations.members falls back to history-derived count', async () => {
    const { fn } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 3 } }),
      slackResponse({ ok: false, error: 'not_in_channel' }),
    ])
    const { cb } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'UDEV',
          authorName: 'dev',
          text: 'q',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'BBOT',
          authorName: 'b',
          text: 'a',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 50,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 50,
      truncated: true,
    })
  })

  test('rate-limit style errors return transient failures (no fallback)', async () => {
    const { fn } = fakeFetch([slackResponse({ ok: false, error: 'rate_limited' })])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      kind: 'transient',
    })
    expect(historyCalls).toHaveLength(0)
  })

  test('permanent failure + history failure surfaces transient (cache retries soon)', async () => {
    const { fn } = fakeFetch([slackResponse({ ok: false, error: 'missing_scope' })])
    const { cb } = fakeHistory({ ok: false, error: 'boom' })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      kind: 'transient',
    })
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
      {
        allow: ['*'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      },
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
    return {
      allow: ['*'],
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }
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
        history: defaultHistoryConfig(),
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
        history: defaultHistoryConfig(),
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

describe('slack-bot createOutboundCallback', () => {
  type PostCall = { channel: string; text: string; options?: { thread_ts?: string } }
  type UploadCall = {
    channel: string
    bytes: number
    filename: string
    options?: { thread_ts?: string; title?: string; initial_comment?: string }
  }

  function makeFakeClient(behavior: { postMessage?: 'ok' | 'reject'; uploadFile?: 'ok' | 'reject' } = {}): {
    client: Pick<SlackBotClient, 'postMessage' | 'uploadFile'>
    posts: PostCall[]
    uploads: UploadCall[]
  } {
    const posts: PostCall[] = []
    const uploads: UploadCall[] = []
    return {
      posts,
      uploads,
      client: {
        postMessage: async (channel, text, options) => {
          posts.push({ channel, text, options })
          if (behavior.postMessage === 'reject') throw new Error('slack_post_failed')
          return { ts: `ts${posts.length}`, text, type: 'message' } as SlackPostedMessage
        },
        uploadFile: async (channel, file, filename, options) => {
          uploads.push({ channel, bytes: file.length, filename, options })
          if (behavior.uploadFile === 'reject') throw new Error('slack_upload_failed')
          return {
            id: `F${uploads.length}`,
            name: filename,
            title: filename,
            mimetype: 'application/octet-stream',
            size: file.length,
            url_private: '',
            created: 0,
            user: 'U1',
          } as SlackFile
        },
      },
    }
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function permissive(): ChannelAdapterConfig {
    return {
      allow: ['*'],
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }
  }

  function makeMsg(overrides: Partial<OutboundMessage>): OutboundMessage {
    return { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'hi', ...overrides } as OutboundMessage
  }

  const tag = async (_w: string, _c: string) => 'team=T0 channel=C0'
  const fakeRead = async (_path: string) => Buffer.from('test-bytes')

  test('text-only path posts via postMessage and never calls uploadFile', async () => {
    // given
    const { client, posts, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    // when
    const result = await cb(makeMsg({ text: 'hello' }))
    // then
    expect(result.ok).toBe(true)
    expect(uploads).toHaveLength(0)
    expect(posts).toEqual([{ channel: 'C0', text: 'hello', options: undefined }])
  })

  test('threaded text-only post forwards thread_ts to postMessage', async () => {
    const { client, posts } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(makeMsg({ text: 'hello', thread: '1700.000100' }))
    expect(posts).toEqual([{ channel: 'C0', text: 'hello', options: { thread_ts: '1700.000100' } }])
  })

  test('text+single-attachment folds text into initial_comment and never calls postMessage', async () => {
    // given
    const { client, posts, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    // when
    await cb(makeMsg({ text: 'caption', attachments: [{ path: '/agent/a.png' }] }))
    // then
    expect(posts).toHaveLength(0)
    expect(uploads).toEqual([{ channel: 'C0', bytes: 10, filename: 'a.png', options: { initial_comment: 'caption' } }])
  })

  test('multi-attachment puts caption only on the FIRST upload; rest are bare', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(makeMsg({ text: 'caption', attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }] }))
    expect(uploads).toEqual([
      { channel: 'C0', bytes: 10, filename: 'a.png', options: { initial_comment: 'caption' } },
      { channel: 'C0', bytes: 10, filename: 'b.pdf', options: {} },
    ])
  })

  test('threaded uploads forward thread_ts on every attachment', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(
      makeMsg({
        text: 'caption',
        thread: '1700.000100',
        attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }],
      }),
    )
    expect(uploads).toEqual([
      {
        channel: 'C0',
        bytes: 10,
        filename: 'a.png',
        options: { thread_ts: '1700.000100', initial_comment: 'caption' },
      },
      { channel: 'C0', bytes: 10, filename: 'b.pdf', options: { thread_ts: '1700.000100' } },
    ])
  })

  test('attachment.filename overrides the path basename', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(makeMsg({ text: undefined, attachments: [{ path: '/agent/tmp-XYZ.bin', filename: 'report.pdf' }] }))
    expect(uploads[0]!.filename).toBe('report.pdf')
  })

  test('attachments-only post (no text) uploads bare, not as initial_comment', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(makeMsg({ text: undefined, attachments: [{ path: '/agent/a.png' }] }))
    expect(uploads).toEqual([{ channel: 'C0', bytes: 10, filename: 'a.png', options: {} }])
  })

  test('upload failure aborts the loop and returns ok:false', async () => {
    const { client, uploads } = makeFakeClient({ uploadFile: 'reject' })
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    const result = await cb(
      makeMsg({ text: 'caption', attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }] }),
    )
    expect(result.ok).toBe(false)
    expect(uploads).toHaveLength(1)
  })

  test('readFile failure surfaces as ok:false without calling uploadFile', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: async () => {
        throw new Error('ENOENT: no such file')
      },
    })
    const result = await cb(makeMsg({ text: undefined, attachments: [{ path: '/agent/missing.png' }] }))
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error : '').toContain('readFile failed')
    expect(uploads).toHaveLength(0)
  })

  test('rejects when message has neither text nor attachments', async () => {
    const { client } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    const result = await cb(makeMsg({ text: undefined, attachments: [] }))
    expect(result.ok).toBe(false)
  })

  test('denies when allow rules reject the channel without reading the file', async () => {
    const { client, posts, uploads } = makeFakeClient()
    let readCalls = 0
    const restrictive = (): ChannelAdapterConfig => ({
      allow: ['team:OTHER/*'],
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    })
    const cb = createOutboundCallback({
      client,
      configRef: restrictive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: async (p) => {
        readCalls++
        return fakeRead(p)
      },
    })
    const result = await cb(makeMsg({ text: 'hi', attachments: [{ path: '/agent/a.png' }] }))
    expect(result.ok).toBe(false)
    expect(posts).toHaveLength(0)
    expect(uploads).toHaveLength(0)
    expect(readCalls).toBe(0)
  })

  test('threaded postMessage triggers typingTracker.clearAfterSend so the indicator does not stay stuck', async () => {
    // given
    const { client, posts } = makeFakeClient()
    const clearCalls: Array<{ chat: string; thread: string | null | undefined }> = []
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async (chat, thread) => {
          clearCalls.push({ chat, thread })
        },
      },
    })
    // when
    const result = await cb(makeMsg({ text: 'hello', thread: '1700.000100' }))
    // then
    expect(result.ok).toBe(true)
    expect(posts).toHaveLength(1)
    expect(clearCalls).toEqual([{ chat: 'C0', thread: '1700.000100' }])
  })

  test('top-level postMessage still calls clearAfterSend (tracker decides the no-op)', async () => {
    const { client } = makeFakeClient()
    const clearCalls: Array<{ chat: string; thread: string | null | undefined }> = []
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async (chat, thread) => {
          clearCalls.push({ chat, thread })
        },
      },
    })
    await cb(makeMsg({ text: 'hello' }))
    expect(clearCalls).toEqual([{ chat: 'C0', thread: undefined }])
  })

  test('threaded uploadFile triggers clearAfterSend after the LAST attachment', async () => {
    // given
    const { client, uploads } = makeFakeClient()
    const clearCalls: Array<{ chat: string; thread: string | null | undefined }> = []
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async (chat, thread) => {
          clearCalls.push({ chat, thread })
        },
      },
    })
    // when
    await cb(
      makeMsg({
        text: 'caption',
        thread: '1700.000100',
        attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }],
      }),
    )
    // then
    expect(uploads).toHaveLength(2)
    expect(clearCalls).toEqual([{ chat: 'C0', thread: '1700.000100' }])
  })

  test('failed postMessage does not call clearAfterSend (no message was actually sent)', async () => {
    const { client } = makeFakeClient({ postMessage: 'reject' })
    const clearCalls: Array<unknown> = []
    const cb = createOutboundCallback({
      client,
      configRef: permissive,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async () => {
          clearCalls.push({})
        },
      },
    })
    const result = await cb(makeMsg({ text: 'hello', thread: '1700.000100' }))
    expect(result.ok).toBe(false)
    expect(clearCalls).toHaveLength(0)
  })
})
