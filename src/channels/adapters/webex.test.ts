import { describe, expect, test } from 'bun:test'

import type { WebexListener, WebexMessage } from 'agent-messenger/webex'

import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'
import type { WebexAccountRecord } from '@/secrets/schema'

import { createWebexAdapter, createWebexHistoryCallback, type WebexAdapterLogger } from './webex'
import type { WebexInboundMessage } from './webex-classify'

const config = channelsSchema.parse({ webex: {} }).webex!

function logger(): WebexAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

function account(overrides: Partial<WebexAccountRecord> = {}): WebexAccountRecord {
  return {
    account_id: 'account-1',
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: 1_800_000_000,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function inbound(overrides: Partial<WebexInboundMessage> = {}): WebexInboundMessage {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    personId: 'user-1',
    personEmail: 'user@example.com',
    text: 'hello typeclaw',
    created: '2026-01-01T00:00:00.000Z',
    roomType: 'group',
    mentionedPeople: [],
    mentionedGroups: [],
    files: [],
    raw: {} as WebexInboundMessage['raw'],
    ...overrides,
  }
}

class FakeListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()
  stopped = false

  on(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  async start(): Promise<void> {
    this.emit('connected', undefined)
  }

  stop(): void {
    this.stopped = true
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
}

function router(): ChannelRouter & { routed: InboundMessage[]; registered: string[]; unregistered: string[] } {
  const routed: InboundMessage[] = []
  const registered: string[] = []
  const unregistered: string[] = []
  return {
    routed,
    registered,
    unregistered,
    route: async (msg: InboundMessage) => {
      routed.push(msg)
    },
    registerOutbound: (adapter: string) => registered.push(`outbound:${adapter}`),
    unregisterOutbound: (adapter: string) => unregistered.push(`outbound:${adapter}`),
    registerChannelNameResolver: (adapter: string) => registered.push(`names:${adapter}`),
    unregisterChannelNameResolver: (adapter: string) => unregistered.push(`names:${adapter}`),
    registerSelfIdentity: (adapter: string) => registered.push(`self:${adapter}`),
    unregisterSelfIdentity: (adapter: string) => unregistered.push(`self:${adapter}`),
    registerHistory: (adapter: string) => registered.push(`history:${adapter}`),
    unregisterHistory: (adapter: string) => unregistered.push(`history:${adapter}`),
    registerFetchAttachment: (adapter: string) => registered.push(`fetch:${adapter}`),
    unregisterFetchAttachment: (adapter: string) => unregistered.push(`fetch:${adapter}`),
    registerMembership: (adapter: string) => registered.push(`membership:${adapter}`),
    unregisterMembership: (adapter: string) => unregistered.push(`membership:${adapter}`),
  } as unknown as ChannelRouter & { routed: InboundMessage[]; registered: string[]; unregistered: string[] }
}

describe('createWebexAdapter', () => {
  test('start logs in with account token and wires listener/router callbacks', async () => {
    const calls: unknown[] = []
    const r = router()
    const listener = new FakeListener()
    const adapter = createWebexAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account({ device_url: 'device-url' }) },
      createClient: () =>
        ({
          login: async (opts: unknown) => calls.push(opts),
          testAuth: async () => ({ id: 'self-1', emails: ['self@example.com'], displayName: 'Self' }),
          listMemberships: async () => [],
          listMessages: async () => [],
          sendMessage: async () => ({ id: 'sent' }),
          uploadFile: async () => ({ id: 'uploaded' }),
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createWebexAdapter>[0]['createClient']>>,
      createListener: () => listener as unknown as WebexListener,
    })

    await adapter.start()

    expect(calls).toEqual([{ token: 'access-1', deviceUrl: 'device-url', tokenType: 'password' }])
    expect(adapter.isConnected()).toBe(true)
    expect(r.registered).toEqual([
      'outbound:webex',
      'names:webex',
      'self:webex',
      'history:webex',
      'fetch:webex',
      'membership:webex',
    ])
  })

  test('auth log decodes the base64 personId to its readable ref', async () => {
    // base64url of ciscospark://us/PEOPLE/b278882e-b28b-4cc4-b08b-4b08db7369db
    const personId = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9iMjc4ODgyZS1iMjhiLTRjYzQtYjA4Yi00YjA4ZGI3MzY5ZGI'
    const log = logger()
    const adapter = createWebexAdapter({
      router: router(),
      configRef: () => config,
      logger: log,
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        ({
          login: async () => {},
          testAuth: async () => ({ id: personId, emails: ['typeey@example.com'], displayName: 'Typeey' }),
          listMemberships: async () => [],
          listMessages: async () => [],
          sendMessage: async () => ({ id: 'sent' }),
          uploadFile: async () => ({ id: 'uploaded' }),
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createWebexAdapter>[0]['createClient']>>,
      createListener: () => new FakeListener() as unknown as WebexListener,
    })

    await adapter.start()

    expect(log.lines).toContain('info:[webex] authenticated as Typeey (b278882e-b28b-4cc4-b08b-4b08db7369db)')
  })

  test('missing account throws the documented error', async () => {
    const adapter = createWebexAdapter({
      router: router(),
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => null },
    })

    await expect(adapter.start()).rejects.toThrow('no Webex account in secrets.json#channels.webex')
  })

  test('message_created routes through classifyInbound', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createWebexAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      selfAliasesRef: () => ['typeclaw'],
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        ({
          login: async () => {},
          testAuth: async () => ({ id: 'self-1', emails: ['self@example.com'], displayName: 'Self' }),
          listMemberships: async () => [],
          listMessages: async () => [],
          sendMessage: async () => ({ id: 'sent' }),
          uploadFile: async () => ({ id: 'uploaded' }),
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createWebexAdapter>[0]['createClient']>>,
      createListener: () => listener as unknown as WebexListener,
    })

    await adapter.start()
    listener.emit('message_created', inbound())
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.adapter).toBe('webex')
    expect(r.routed[0]?.isBotMention).toBe(true)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:webex')
  })

  test('inbound/routed logs decode the base64 room and message ids', async () => {
    // base64url of ciscospark://us/ROOM/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    const roomId = 'Y2lzY29zcGFyazovL3VzL1JPT00vYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl'
    // base64url of ciscospark://us/MESSAGE/99999999-8888-7777-6666-555555555555
    const msgId = 'Y2lzY29zcGFyazovL3VzL01FU1NBR0UvOTk5OTk5OTktODg4OC03Nzc3LTY2NjYtNTU1NTU1NTU1NTU1'
    const log = logger()
    const listener = new FakeListener()
    const adapter = createWebexAdapter({
      router: router(),
      configRef: () => config,
      logger: log,
      selfAliasesRef: () => ['typeclaw'],
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        ({
          login: async () => {},
          testAuth: async () => ({ id: 'self-1', emails: ['self@example.com'], displayName: 'Self' }),
          listMemberships: async () => [],
          listMessages: async () => [],
          sendMessage: async () => ({ id: 'sent' }),
          uploadFile: async () => ({ id: 'uploaded' }),
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createWebexAdapter>[0]['createClient']>>,
      createListener: () => listener as unknown as WebexListener,
    })

    await adapter.start()
    listener.emit('message_created', inbound({ id: msgId, roomId, text: 'hello typeclaw' }))
    await adapter.stop()

    const inboundLine = log.lines.find((l) => l.includes('inbound id='))
    expect(inboundLine).toContain('id=99999999-8888-7777-6666-555555555555')
    expect(inboundLine).toContain('room=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(inboundLine).not.toContain('Y2lz')
  })
})

describe('createWebexHistoryCallback reply attribution', () => {
  const message = (over: Partial<WebexMessage>): WebexMessage => ({
    id: 'm',
    roomId: 'room-1',
    roomType: 'group',
    text: 'hi',
    personId: 'p',
    personEmail: 'p@example.com',
    created: '2026-01-01T00:00:00.000Z',
    files: [],
    ...over,
  })

  const historyOf = async (messages: WebexMessage[], botPersonId: string | null) => {
    const cb = createWebexHistoryCallback({
      client: { listMessages: async () => messages },
      logger: logger(),
      botPersonIdRef: () => botPersonId,
    })
    const res = await cb({ chat: 'room-1', thread: null, limit: 50 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok history result')
    return res.messages
  }

  test('leaves replyToBotMessageId null when the threaded parent was authored by a human', async () => {
    const parent = message({ id: 'parent-1', personId: 'human-1' })
    const child = message({ id: 'child-1', personId: 'human-2', parentId: 'parent-1' })
    const history = await historyOf([parent, child], 'bot-1')
    expect(history.find((m) => m.externalMessageId === 'child-1')?.replyToBotMessageId).toBeNull()
  })

  test('attributes replyToBotMessageId when the threaded parent was authored by the bot', async () => {
    const parent = message({ id: 'parent-1', personId: 'bot-1' })
    const child = message({ id: 'child-1', personId: 'human-2', parentId: 'parent-1' })
    const history = await historyOf([parent, child], 'bot-1')
    expect(history.find((m) => m.externalMessageId === 'child-1')?.replyToBotMessageId).toBe('parent-1')
  })

  test('leaves replyToBotMessageId null when the threaded parent is outside the fetched batch', async () => {
    const child = message({ id: 'child-1', personId: 'human-2', parentId: 'parent-unknown' })
    const history = await historyOf([child], 'bot-1')
    expect(history.find((m) => m.externalMessageId === 'child-1')?.replyToBotMessageId).toBeNull()
  })
})
