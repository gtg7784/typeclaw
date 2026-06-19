import { describe, expect, test } from 'bun:test'

import type { WebexBotListener } from 'agent-messenger/webexbot'

import { MEMBERSHIP_ENUMERATION_CAP } from '@/channels/membership'
import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { OutboundMessage } from '@/channels/types'

import {
  createFetchAttachmentCallback,
  createOutboundCallback,
  createWebexBotAdapter,
  createWebexHistoryCallback,
  createWebexMembershipResolver,
  type WebexBotAdapterLogger,
} from './webex-bot'
import type { WebexInboundMessage } from './webex-bot-classify'

const config = channelsSchema.parse({ 'webex-bot': {} })['webex-bot']!

function logger(): WebexBotAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

describe('webex outbound', () => {
  test('sends markdown messages and warns when thread/attachments are unsupported', async () => {
    const calls: Array<{ roomId: string; text: string; markdown?: boolean }> = []
    const log = logger()
    const cb = createOutboundCallback({
      client: {
        sendMessage: async (roomId, text, options) => {
          calls.push({ roomId, text, markdown: options?.markdown })
          return webexMessage({ id: 'sent', text })
        },
      },
      logger: log,
      formatChannelTag: async () => 'room=Room(room-1)',
    })

    const result = await cb(outbound({ text: '**hello**', thread: 'parent', attachments: [{ path: '/tmp/a.txt' }] }))

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ roomId: 'room-1', text: '**hello**', markdown: true }])
    expect(log.lines.some((line) => line.includes('dropping 1 outbound attachment'))).toBe(true)
    expect(log.lines.some((line) => line.includes('thread reply to room root'))).toBe(true)
  })

  test('rejects attachment-only messages', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => webexMessage({ id: 'unused' }) },
      logger: logger(),
      formatChannelTag: async () => 'room=room-1',
    })

    await expect(cb(outbound({ text: '', attachments: [{ path: '/tmp/a.txt' }] }))).resolves.toEqual({
      ok: false,
      error: 'webex-bot does not support outbound file attachments',
    })
  })
})

describe('webex history and membership', () => {
  test('maps newest-first history to oldest-first', async () => {
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => [
          webexMessage({ id: 'new', text: 'new', personId: 'user-2', created: '2026-01-02T00:00:00Z' }),
          webexMessage({ id: 'old', text: 'old', personId: 'bot-1', created: '2026-01-01T00:00:00Z' }),
        ],
      },
      logger: logger(),
      botPersonIdRef: () => 'bot-1',
    })

    const result = await cb({ chat: 'room-1', thread: null, limit: 10 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => [m.externalMessageId, m.text, m.isBot])).toEqual([
      ['old', 'old', true],
      ['new', 'new', false],
    ])
    expect(result.nextCursor).toBeUndefined()
  })

  test('returns ok false on history failure', async () => {
    const cb = createWebexHistoryCallback({
      client: { listMessages: async () => Promise.reject(new Error('down')) },
      logger: logger(),
      botPersonIdRef: () => null,
    })

    await expect(cb({ chat: 'room-1', thread: null, limit: 10 })).resolves.toEqual({ ok: false, error: 'down' })
  })

  test('resolves direct and group membership, falling back to history on failure', async () => {
    const history = createWebexHistoryCallback({
      client: { listMessages: async () => [webexMessage({ personId: 'user-1' }), webexMessage({ personId: 'bot-1' })] },
      logger: logger(),
      botPersonIdRef: () => 'bot-1',
    })
    let fail = false
    const resolver = createWebexMembershipResolver({
      client: {
        listMemberships: async () => {
          if (fail) throw new Error('nope')
          return [membership('bot-1'), membership('user-1'), membership('user-2')]
        },
      },
      logger: logger(),
      historyCallback: history,
      botPersonIdRef: () => 'bot-1',
      now: () => 123,
    })

    await expect(resolver({ adapter: 'webex-bot', workspace: '@dm', chat: 'dm-1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 123,
      truncated: false,
    })
    await expect(
      resolver({ adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', thread: null }),
    ).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 123,
      truncated: false,
      humanMemberIds: ['user-1', 'user-2'],
    })
    fail = true
    await expect(
      resolver({ adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', thread: null }),
    ).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 123,
      truncated: true,
    })
  })

  test('marks membership truncated and omits humanMemberIds when the read hits the enumeration cap', async () => {
    const members = Array.from({ length: MEMBERSHIP_ENUMERATION_CAP }, (_, i) => membership(`user-${i}`))
    const resolver = createWebexMembershipResolver({
      client: { listMemberships: async () => members },
      logger: logger(),
      historyCallback: createWebexHistoryCallback({
        client: { listMessages: async () => [] },
        logger: logger(),
        botPersonIdRef: () => 'bot-1',
      }),
      botPersonIdRef: () => 'bot-1',
      now: () => 123,
    })

    await expect(
      resolver({ adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', thread: null }),
    ).resolves.toEqual({
      humans: MEMBERSHIP_ENUMERATION_CAP,
      bots: 0,
      fetchedAt: 123,
      truncated: true,
    })
  })
})

describe('webex fetch attachment', () => {
  test('downloads Webex content URLs with bearer auth', async () => {
    const calls: Array<{ url: string; auth?: string }> = []
    const cb = createFetchAttachmentCallback({
      token: 'token-1',
      logger: logger(),
      fetchImpl: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          calls.push({ url: String(input), auth: headers.get('authorization') ?? undefined })
          return new Response('file-body', { headers: { 'content-type': 'text/plain' } })
        },
        { preconnect: () => {} },
      ),
    })

    const result = await cb({ ref: 'https://cdn.webexcontent.com/files/a.txt' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('a.txt')
    expect(result.buffer.toString()).toBe('file-body')
    expect(calls).toEqual([{ url: 'https://cdn.webexcontent.com/files/a.txt', auth: 'Bearer token-1' }])
  })

  test('rejects non-Webex hosts', async () => {
    const cb = createFetchAttachmentCallback({ token: 'token-1', logger: logger() })

    await expect(cb({ ref: 'https://example.com/file.txt' })).resolves.toEqual({
      ok: false,
      error: 'not a Webex file URL: example.com',
    })
  })

  test('refuses http:// on allowlisted hosts without leaking the bearer token', async () => {
    // given: a fetch impl that records every call so we can assert none happened
    const calls: string[] = []
    const cb = createFetchAttachmentCallback({
      token: 'token-1',
      logger: logger(),
      fetchImpl: Object.assign(
        async (input: RequestInfo | URL) => {
          calls.push(String(input))
          return new Response('file-body')
        },
        { preconnect: () => {} },
      ),
    })

    // when: an allowlisted host is requested over plaintext http
    const apex = await cb({ ref: 'http://webexapis.com/file.txt' })
    const subdomain = await cb({ ref: 'http://cdn.webexcontent.com/files/a.txt' })

    // then: both are refused and the credentialed fetch is never issued
    expect(apex).toEqual({ ok: false, error: 'Webex file URL must use https: http://webexapis.com' })
    expect(subdomain).toEqual({ ok: false, error: 'Webex file URL must use https: http://cdn.webexcontent.com' })
    expect(calls).toEqual([])
  })
})

describe('webex lifecycle', () => {
  test('starts, registers callbacks, routes messages, and stops cleanly', async () => {
    const listener = new FakeListener()
    const router = new FakeRouter()
    const adapter = createWebexBotAdapter({
      router: router.value,
      configRef: () => config,
      token: 'token-1',
      logger: logger(),
      createClient: () => fakeClient(),
      createListener: () => listener.value,
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    expect(router.registered).toEqual([
      'outbound',
      'channelNameResolver',
      'selfIdentity',
      'history',
      'fetchAttachment',
      'membership',
    ])
    expect(router.selfIdentity?.('@dm')).toEqual({ id: 'bot-1', username: 'bot@example.com' })

    listener.emit('message_created', inbound({ mentionedPeople: ['bot-1'] }))
    await router.waitForRoutes(1)
    expect(router.routes[0]?.externalMessageId).toBe('msg-1')

    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
    expect(router.unregistered).toEqual(router.registered)
  })

  test('rolls back registrations when listener start fails', async () => {
    const listener = new FakeListener({ failStart: true })
    const router = new FakeRouter()
    const adapter = createWebexBotAdapter({
      router: router.value,
      configRef: () => config,
      token: 'token-1',
      logger: logger(),
      createClient: () => fakeClient(),
      createListener: () => listener.value,
    })

    await expect(adapter.start()).rejects.toThrow('start failed')
    expect(router.unregistered).toEqual(router.registered)
    expect(adapter.isConnected()).toBe(false)
  })

  test('stop before connected is a no-op', async () => {
    const adapter = createWebexBotAdapter({
      router: new FakeRouter().value,
      configRef: () => config,
      token: 'token-1',
      logger: logger(),
      createClient: () => fakeClient(),
      createListener: () => new FakeListener().value,
    })

    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
  })
})

class FakeListener {
  private handlers = new Map<string, Array<(arg: unknown) => void>>()
  readonly value = this as unknown as WebexBotListener

  constructor(private readonly options: { failStart?: boolean } = {}) {}

  on(event: string, listener: (arg: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }

  off(): this {
    return this
  }

  once(event: string, listener: (arg: unknown) => void): this {
    return this.on(event, listener)
  }

  async start(): Promise<void> {
    if (this.options.failStart) throw new Error('start failed')
    this.emit('connected', { connected: true, status: 'connected' })
  }

  async stop(): Promise<void> {}

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }
}

class FakeRouter {
  readonly registered: string[] = []
  readonly unregistered: string[] = []
  readonly routes: Array<{ externalMessageId: string }> = []
  selfIdentity: ((workspace: string) => { id: string; username?: string } | null) | null = null
  private waiters: Array<() => void> = []
  readonly value = {
    route: async (msg: { externalMessageId: string }) => {
      this.routes.push(msg)
      const waiters = this.waiters
      this.waiters = []
      for (const waiter of waiters) waiter()
    },
    registerOutbound: () => this.registered.push('outbound'),
    unregisterOutbound: () => this.unregistered.push('outbound'),
    registerChannelNameResolver: () => this.registered.push('channelNameResolver'),
    unregisterChannelNameResolver: () => this.unregistered.push('channelNameResolver'),
    registerSelfIdentity: (_adapter: string, cb: (workspace: string) => { id: string; username?: string } | null) => {
      this.selfIdentity = cb
      this.registered.push('selfIdentity')
    },
    unregisterSelfIdentity: () => this.unregistered.push('selfIdentity'),
    registerHistory: () => this.registered.push('history'),
    unregisterHistory: () => this.unregistered.push('history'),
    registerFetchAttachment: () => this.registered.push('fetchAttachment'),
    unregisterFetchAttachment: () => this.unregistered.push('fetchAttachment'),
    registerMembership: () => this.registered.push('membership'),
    unregisterMembership: () => this.unregistered.push('membership'),
  } as unknown as ChannelRouter

  async waitForRoutes(count: number): Promise<void> {
    if (this.routes.length >= count) return
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
}

function fakeClient() {
  return {
    login: async () => fakeClient(),
    getToken: () => 'token-1',
    testAuth: async () => ({
      id: 'bot-1',
      emails: ['bot@example.com'],
      displayName: 'Bot',
      orgId: 'org-1',
      type: 'bot',
      created: '',
    }),
    sendMessage: async () => webexMessage({ id: 'sent' }),
    getSpace: async () => ({
      id: 'room-1',
      title: 'Room',
      type: 'group',
      isLocked: false,
      lastActivity: '',
      created: '',
      creatorId: '',
    }),
    listMessages: async () => [],
    listMemberships: async () => [],
    getMessage: async () => webexMessage({ id: 'parent', text: 'parent' }),
  } as unknown as ReturnType<NonNullable<Parameters<typeof createWebexBotAdapter>[0]['createClient']>>
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return { adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', text: 'hello', ...overrides }
}

function inbound(overrides: Partial<WebexInboundMessage> = {}): WebexInboundMessage {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    personId: 'user-1',
    personEmail: 'user@example.com',
    text: 'hello',
    created: '2026-01-01T00:00:00Z',
    roomType: 'group',
    mentionedPeople: [],
    mentionedGroups: [],
    files: [],
    raw: {} as WebexInboundMessage['raw'],
    ...overrides,
  }
}

function webexMessage(overrides: Partial<ReturnType<typeof webexMessageShape>> = {}) {
  return { ...webexMessageShape(), ...overrides }
}

function webexMessageShape() {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    roomType: 'group' as const,
    text: 'hello',
    personId: 'user-1',
    personEmail: 'user@example.com',
    created: '2026-01-01T00:00:00Z',
  }
}

function membership(personId: string) {
  return {
    id: `m-${personId}`,
    roomId: 'room-1',
    personId,
    personEmail: `${personId}@example.com`,
    personDisplayName: personId,
    isModerator: false,
    created: '',
  }
}
