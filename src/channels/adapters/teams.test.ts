import { describe, expect, test } from 'bun:test'

import type { TeamsListener, TeamsMessage, TeamsRealtimeMessage, TeamsUser } from 'agent-messenger/teams'

import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { InboundMessage, OutboundCallback, OutboundMessage } from '@/channels/types'
import type { TeamsAccountRecord } from '@/secrets/schema'

import {
  createOutboundCallback,
  createTeamsAdapter,
  createTeamsHistoryCallback,
  type TeamsAdapterLogger,
  type TeamsChatInfo,
} from './teams'

const config = channelsSchema.parse({ teams: {} }).teams!

const SELF: TeamsUser = { id: 'ME', displayName: 'Typeey', userPrincipalName: 'typeey@example.com' }

function logger(): TeamsAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

function account(overrides: Partial<TeamsAccountRecord> = {}): TeamsAccountRecord {
  return {
    account_id: 'account-1',
    access_token: 'access-1',
    account_type: 'work',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function realtime(overrides: Partial<TeamsRealtimeMessage> = {}): TeamsRealtimeMessage {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    content: 'hello typeclaw',
    author: { id: 'user-1', displayName: 'Alice' },
    messageType: 'RichText/Html',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function teamsMessage(overrides: Partial<TeamsMessage> = {}): TeamsMessage {
  return {
    id: 'm',
    channel_id: 'chat-1',
    author: { id: 'user-1', displayName: 'Alice' },
    content: 'hi',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return { adapter: 'teams', workspace: 'teams', chat: 'chat:chat-1', text: 'hello', ...overrides }
}

const groupChat: TeamsChatInfo = { id: 'chat-1', type: 'group' } as TeamsChatInfo

class FakeListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()
  stopped = false
  startImpl: () => Promise<void> = async () => {
    // Real TeamsListener emits `connected` asynchronously after start()
    // resolves; mirror that so the adapter's await-connected path is exercised.
    queueMicrotask(() => this.emit('connected', { endpointId: 'ep-1' }))
  }

  on(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  off(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((h) => h !== handler),
    )
  }

  async start(): Promise<void> {
    await this.startImpl()
  }

  stop(): void {
    this.stopped = true
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
}

type TestRouter = ChannelRouter & {
  routed: InboundMessage[]
  registered: string[]
  unregistered: string[]
  outboundCb: OutboundCallback | null
}

function router(): TestRouter {
  const routed: InboundMessage[] = []
  const registered: string[] = []
  const unregistered: string[] = []
  const state = { outboundCb: null as OutboundCallback | null }
  return {
    routed,
    registered,
    unregistered,
    get outboundCb() {
      return state.outboundCb
    },
    route: async (msg: InboundMessage) => {
      routed.push(msg)
    },
    registerOutbound: (adapter: string, cb: OutboundCallback) => {
      registered.push(`outbound:${adapter}`)
      state.outboundCb = cb
    },
    unregisterOutbound: (adapter: string) => unregistered.push(`outbound:${adapter}`),
    registerSelfIdentity: (adapter: string) => registered.push(`self:${adapter}`),
    unregisterSelfIdentity: (adapter: string) => unregistered.push(`self:${adapter}`),
    registerHistory: (adapter: string) => registered.push(`history:${adapter}`),
    unregisterHistory: (adapter: string) => unregistered.push(`history:${adapter}`),
    getSelfAliases: () => [],
  } as unknown as TestRouter
}

type ClientOverrides = {
  chats?: TeamsChatInfo[]
  sendChatMessage?: (chatId: string, content: string) => Promise<TeamsMessage>
  getChatMessages?: (chatId: string, limit?: number) => Promise<TeamsMessage[]>
  testAuth?: () => Promise<TeamsUser>
}

function fakeClient(overrides: ClientOverrides = {}) {
  const sends: Array<{ chatId: string; content: string }> = []
  const client = {
    login: async () => {},
    testAuth: overrides.testAuth ?? (async () => SELF),
    listChats: async () => overrides.chats ?? [groupChat],
    sendChatMessage:
      overrides.sendChatMessage ??
      (async (chatId: string, content: string) => {
        sends.push({ chatId, content })
        return teamsMessage({ id: 'sent', content })
      }),
    getChatMessages: overrides.getChatMessages ?? (async () => []),
  }
  return { sends, client }
}

function adapterWith(deps: {
  r: ReturnType<typeof router>
  listener: FakeListener
  client: ReturnType<typeof fakeClient>['client']
  log?: TeamsAdapterLogger
  aliases?: readonly string[]
  store?: { getAccount: () => Promise<TeamsAccountRecord | null> }
  now?: () => number
}) {
  return createTeamsAdapter({
    router: deps.r,
    configRef: () => config,
    logger: deps.log ?? logger(),
    ...(deps.aliases ? { selfAliasesRef: () => deps.aliases! } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    credentialsStore: deps.store ?? { getAccount: async () => account() },
    createClient: () =>
      deps.client as unknown as ReturnType<NonNullable<Parameters<typeof createTeamsAdapter>[0]['createClient']>>,
    createListener: () => deps.listener as unknown as TeamsListener,
  })
}

describe('teams outbound', () => {
  test('sends to the decoded chat id and returns the sent message id', async () => {
    const { sends, client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    const result = await cb(outbound({ text: 'hi' }))

    expect(result).toEqual({ ok: true, messageId: 'sent', messageIds: ['sent'] })
    expect(sends).toEqual([{ chatId: 'chat-1', content: 'hi' }])
  })

  test('rejects a non chat: routing key', async () => {
    const { client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    expect(await cb(outbound({ chat: 'channel:team/ch' }))).toEqual({
      ok: false,
      error: 'unsupported Teams chat id: channel:team/ch',
    })
  })

  test('rejects an empty message', async () => {
    const { client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    expect(await cb(outbound({ text: '' }))).toEqual({ ok: false, error: 'message has no text' })
  })

  test('surfaces a send failure as ok false', async () => {
    const cb = createOutboundCallback({
      client: {
        sendChatMessage: async () => {
          throw new Error('send boom')
        },
      },
      logger: logger(),
    })

    await expect(cb(outbound({ text: 'hi' }))).resolves.toEqual({ ok: false, error: 'send boom' })
  })

  test('reserves the echo before sending and does not roll it back on success', async () => {
    const rollbacks: number[] = []
    let rolledBack = 0
    const { client } = fakeClient()
    const cb = createOutboundCallback({
      client,
      logger: logger(),
      reserveEcho: (chatId, text) => {
        rollbacks.push(1)
        expect({ chatId, text }).toEqual({ chatId: 'chat-1', text: 'hi there' })
        return () => {
          rolledBack++
        }
      },
    })

    await cb(outbound({ text: 'hi there' }))

    expect(rollbacks).toHaveLength(1)
    expect(rolledBack).toBe(0)
  })

  test('rolls back the reserved echo when the send throws', async () => {
    let rolledBack = 0
    const cb = createOutboundCallback({
      client: {
        sendChatMessage: async () => {
          throw new Error('send boom')
        },
      },
      logger: logger(),
      reserveEcho: () => () => {
        rolledBack++
      },
    })

    await cb(outbound({ text: 'hi there' }))

    expect(rolledBack).toBe(1)
  })
})

describe('teams history', () => {
  test('maps messages to chronological history', async () => {
    const cb = createTeamsHistoryCallback({
      client: {
        getChatMessages: async () => [
          teamsMessage({ id: 'newer', content: 'reply' }),
          teamsMessage({ id: 'older', content: 'question' }),
        ],
      },
      logger: logger(),
      selfIdRef: () => 'ME',
    })

    const res = await cb({ chat: 'chat:chat-1', thread: null, limit: 50 })

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok history')
    expect(res.messages.map((m) => m.externalMessageId)).toEqual(['older', 'newer'])
  })

  test('rejects a non chat: routing key', async () => {
    const cb = createTeamsHistoryCallback({
      client: { getChatMessages: async () => [] },
      logger: logger(),
      selfIdRef: () => null,
    })

    expect(await cb({ chat: 'channel:x', thread: null, limit: 50 })).toEqual({
      ok: false,
      error: 'unsupported Teams chat id: channel:x',
    })
  })
})

describe('createTeamsAdapter', () => {
  test('start logs in with the account token and wires router callbacks', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await adapter.start()

    expect(adapter.isConnected()).toBe(true)
    expect(r.registered).toEqual(['outbound:teams', 'self:teams', 'history:teams'])

    await adapter.stop()
  })

  test('missing account throws the documented error', async () => {
    const adapter = adapterWith({
      r: router(),
      listener: new FakeListener(),
      client: fakeClient().client,
      store: { getAccount: async () => null },
    })

    await expect(adapter.start()).rejects.toThrow('no Teams account in secrets.json#channels.teams')
  })

  test('a realtime group message that matches an alias routes', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({ r, listener, client: fakeClient().client, aliases: ['typeclaw'] })

    await adapter.start()
    listener.emit('message', realtime())
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.adapter).toBe('teams')
    expect(r.routed[0]?.chat).toBe('chat:chat-1')
    expect(r.routed[0]?.isBotMention).toBe(true)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:teams')
  })

  test('drops an inbound that echoes a message the agent just sent (content-only window)', async () => {
    const r = router()
    const listener = new FakeListener()
    let clock = 1_000
    const adapter = adapterWith({ r, listener, client: fakeClient().client, now: () => clock })

    await adapter.start()
    // given the agent sends "on it" through its own registered outbound callback
    expect(r.outboundCb).not.toBeNull()
    await r.outboundCb!(outbound({ text: 'on it' }))
    // when that exact text echoes back 1s later from an author we cannot prove is self
    clock += 1_000
    listener.emit(
      'message',
      realtime({ id: 'echo-1', content: 'on it', author: { id: 'user-1', displayName: 'Alice' } }),
    )
    await adapter.stop()

    // then the recent-send fingerprint drops it inside the 5s content-only window
    expect(r.routed).toHaveLength(0)
  })

  test('does not drop a repeat of the agent text once the content-only window has passed', async () => {
    const r = router()
    const listener = new FakeListener()
    let clock = 1_000
    const adapter = adapterWith({ r, listener, client: fakeClient().client, now: () => clock })

    await adapter.start()
    await r.outboundCb!(outbound({ text: 'on it' }))
    // 6s later a human genuinely typing the same short phrase is NOT an echo
    clock += 6_000
    listener.emit(
      'message',
      realtime({ id: 'human-1', content: 'on it', author: { id: 'user-1', displayName: 'Alice' } }),
    )
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
  })

  test('drops a self-name-authored echo across the full echo TTL', async () => {
    const r = router()
    const listener = new FakeListener()
    let clock = 1_000
    const adapter = adapterWith({ r, listener, client: fakeClient().client, now: () => clock })

    await adapter.start()
    await r.outboundCb!(outbound({ text: 'status update' }))
    // 30s later (past the content-only window) an author whose display name IS
    // the bot's name echoes the text back → still suppressed
    clock += 30_000
    listener.emit(
      'message',
      realtime({ id: 'echo-2', content: 'status update', author: { id: 'x', displayName: 'Typeey' } }),
    )
    await adapter.stop()

    expect(r.routed).toHaveLength(0)
  })

  test('a DM without any alias still engages', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({
      r,
      listener,
      client: fakeClient({ chats: [{ id: 'chat-1', type: 'oneOnOne' } as TeamsChatInfo] }).client,
    })

    await adapter.start()
    listener.emit('message', realtime({ content: 'no alias here' }))
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.isDm).toBe(true)
    expect(r.routed[0]?.mentionsOthers).toBe(false)
  })

  test('refreshes chats once when a realtime chatId is unknown, then routes', async () => {
    const r = router()
    const listener = new FakeListener()
    let listChatsCalls = 0
    const client = {
      login: async () => {},
      testAuth: async () => SELF,
      listChats: async () => {
        listChatsCalls++
        // first call (start) returns nothing; the on-miss refresh discovers the chat
        return listChatsCalls === 1 ? [] : [{ id: 'chat-9', type: 'oneOnOne' } as TeamsChatInfo]
      },
      sendChatMessage: async () => teamsMessage(),
      getChatMessages: async () => [],
    }
    const adapter = adapterWith({ r, listener, client: client as unknown as ReturnType<typeof fakeClient>['client'] })

    await adapter.start()
    listener.emit('message', realtime({ chatId: 'chat-9' }))
    await adapter.stop()

    expect(listChatsCalls).toBe(2)
    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.chat).toBe('chat:chat-9')
  })

  test('isConnected is false after a disconnected event', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    listener.emit('disconnected', undefined)
    expect(adapter.isConnected()).toBe(false)

    await adapter.stop()
  })

  test('rolls back every registration when the listener errors before connecting', async () => {
    const r = router()
    const listener = new FakeListener()
    listener.startImpl = async () => {
      queueMicrotask(() => listener.emit('error', new Error('trouter down')))
    }
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await expect(adapter.start()).rejects.toThrow('trouter down')
    expect(adapter.isConnected()).toBe(false)
    expect(r.unregistered).toEqual(['outbound:teams', 'self:teams', 'history:teams'])
    expect(listener.stopped).toBe(true)
  })

  test('a listener error that arrives after start() resolves still rolls back', async () => {
    const r = router()
    const listener = new FakeListener()
    // start() resolves without connecting; the error lands on the next tick,
    // so the adapter must be awaiting the connected/error race (not sampling a
    // flag synchronously) to observe it.
    listener.startImpl = async () => {
      queueMicrotask(() => listener.emit('error', new Error('late trouter failure')))
    }
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await expect(adapter.start()).rejects.toThrow('late trouter failure')
    expect(adapter.isConnected()).toBe(false)
    expect(r.unregistered).toEqual(['outbound:teams', 'self:teams', 'history:teams'])
    expect(listener.stopped).toBe(true)
  })

  test('rolls back when listener.start() rejects synchronously without emitting error', async () => {
    const r = router()
    const listener = new FakeListener()
    // start() rejects itself and never emits a `connected`/`error` event, so
    // the adapter must cancel the connected-wait in the rejection path (not
    // hang for the full 20s timeout) and still roll back cleanly.
    listener.startImpl = async () => {
      throw new Error('start rejected')
    }
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await expect(adapter.start()).rejects.toThrow('start rejected')
    expect(adapter.isConnected()).toBe(false)
    expect(r.unregistered).toEqual(['outbound:teams', 'self:teams', 'history:teams'])
    expect(listener.stopped).toBe(true)
  })

  test('suppresses an echo delivered before the send promise resolves', async () => {
    const r = router()
    const listener = new FakeListener()
    // Hold sendChatMessage open so the echo lands while the send is in flight —
    // the fingerprint must already be reserved (before the await), or the
    // agent's own message routes back in.
    const release = Promise.withResolvers<TeamsMessage>()
    const adapter = adapterWith({
      r,
      listener,
      client: fakeClient({ sendChatMessage: () => release.promise }).client,
    })

    await adapter.start()
    const sendResult = r.outboundCb!(outbound({ text: 'working on it' }))
    listener.emit('message', realtime({ id: 'echo-live', content: 'working on it' }))
    release.resolve(teamsMessage({ id: 'sent' }))
    await sendResult
    await adapter.stop()

    expect(r.routed).toHaveLength(0)
  })

  test('routes a normal message even if a concurrent send is rolled back on failure', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({
      r,
      listener,
      client: fakeClient({
        sendChatMessage: async () => {
          throw new Error('send failed')
        },
      }).client,
    })

    await adapter.start()
    // A failed send rolls back its reservation, so an unrelated human message
    // with the same text is NOT wrongly suppressed.
    await r.outboundCb!(outbound({ text: 'hello there' }))
    listener.emit('message', realtime({ id: 'human', content: 'hello there' }))
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
  })
})
