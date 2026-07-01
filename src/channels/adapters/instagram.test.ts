import { describe, expect, test } from 'bun:test'

import type { InstagramChatSummary, InstagramMessageSummary } from 'agent-messenger/instagram'

import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage, OutboundMessage } from '@/channels/types'

import {
  createInstagramAdapter,
  createInstagramHistoryCallback,
  createOutboundCallback,
  resolveInstagramListenerCtor,
  type ConnectedPayload,
  type InstagramClientShape,
  type InstagramListenerShape,
} from './instagram'

const SILENT = { info: () => {}, warn: () => {}, error: () => {} }

class FakeListener implements InstagramListenerShape {
  connected?: (payload: ConnectedPayload) => void
  message?: (message: InstagramMessageSummary) => void
  error?: (error: Error) => void
  disconnected?: () => void
  started = false
  stopped = false
  start = async (): Promise<void> => {
    this.started = true
  }
  stop = (): void => {
    this.stopped = true
  }
  on(event: 'connected', handler: (payload: ConnectedPayload) => void): this
  on(event: 'message', handler: (message: InstagramMessageSummary) => void): this
  on(event: 'error', handler: (error: Error) => void): this
  on(event: 'disconnected', handler: () => void): this
  on(event: string, handler: unknown): this {
    if (event === 'connected') this.connected = handler as (payload: ConnectedPayload) => void
    if (event === 'message') this.message = handler as (message: InstagramMessageSummary) => void
    if (event === 'error') this.error = handler as (error: Error) => void
    if (event === 'disconnected') this.disconnected = handler as () => void
    return this
  }
  off(): this {
    return this
  }
}

function chat(overrides: Partial<InstagramChatSummary> = {}): InstagramChatSummary {
  return {
    id: 'T1',
    name: 'Alice',
    type: 'private',
    is_group: false,
    participant_count: 2,
    unread_count: 0,
    ...overrides,
  }
}

function msg(overrides: Partial<InstagramMessageSummary> = {}): InstagramMessageSummary {
  return {
    id: 'M1',
    thread_id: 'T1',
    from: 'U_other',
    from_name: 'Alice',
    timestamp: '2025-01-02T00:00:00.000Z',
    is_outgoing: false,
    type: 'text',
    text: 'hello bot',
    ...overrides,
  }
}

type FakeInstagramClient = InstagramClientShape & {
  loginCalls: Array<{ credentials: { username: string; password: string } | undefined; accountId: string | undefined }>
}

function fakeClient(overrides: Partial<InstagramClientShape> = {}): FakeInstagramClient {
  const loginCalls: Array<{
    credentials: { username: string; password: string } | undefined
    accountId: string | undefined
  }> = []
  const base: FakeInstagramClient = {
    loginCalls,
    login: async function (this: FakeInstagramClient, credentials, accountId): Promise<FakeInstagramClient> {
      loginCalls.push({ credentials, accountId })
      return this
    },
    getProfile: async () => ({ user_id: 'U_self', username: 'bot', full_name: null, profile_pic_url: null }),
    listChats: async () => [chat()],
    getMessages: async () => [],
    sendMessage: async (threadId, text) =>
      msg({ id: 'M_sent', thread_id: threadId, from: 'U_self', text, is_outgoing: true }),
    getUserId: () => 'U_self',
  }
  return Object.assign(base, overrides)
}

describe('resolveInstagramListenerCtor', () => {
  test('resolves the installed 2.28.0 module to hybrid (realtime)', () => {
    expect(resolveInstagramListenerCtor().transport).toBe('hybrid')
  })
})

describe('createOutboundCallback', () => {
  const tag = async (): Promise<string> => 'tag'

  test('sends markdown-stripped plain text and maps id', async () => {
    const sent: Array<{ chat: string; text: string }> = []
    const cb = createOutboundCallback({
      client: {
        sendMessage: async (chat, text) => {
          sent.push({ chat, text })
          return msg({ id: 'M', thread_id: chat, text })
        },
      },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({
      adapter: 'instagram',
      workspace: '@instagram-dm',
      chat: 'T1',
      text: '**hi**',
    } as OutboundMessage)
    expect(res).toEqual({ ok: true, messageId: 'M', messageIds: ['M'] })
    expect(sent).toEqual([{ chat: 'T1', text: 'hi' }])
  })

  test('rejects attachments, empty text, and wrong adapter', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => msg() },
      logger: SILENT,
      formatChannelTag: tag,
    })
    expect(
      (
        await cb({
          adapter: 'instagram',
          workspace: '@instagram-dm',
          chat: 'T1',
          text: 'hi',
          attachments: [{ path: '/tmp/x.png' }],
        } as OutboundMessage)
      ).ok,
    ).toBe(false)
    expect(
      (await cb({ adapter: 'instagram', workspace: '@instagram-dm', chat: 'T1', text: '' } as OutboundMessage)).ok,
    ).toBe(false)
    expect((await cb({ adapter: 'line', workspace: '@line-dm', chat: 'T1', text: 'hi' } as OutboundMessage)).ok).toBe(
      false,
    )
  })
})

describe('createInstagramHistoryCallback', () => {
  test('maps messages', async () => {
    const cb = createInstagramHistoryCallback({
      client: {
        getMessages: async () => [msg({ from: 'U_self', is_outgoing: true }), msg({ id: 'M2', from_name: undefined })],
      },
      logger: SILENT,
      selfUserIdRef: () => 'U_self',
    })
    const res = await cb({ chat: 'T1', thread: null, limit: 50 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.messages[0]!.isBot).toBe(true)
    expect(res.messages[1]!.authorName).toBe('U_other')
  })
})

describe('createInstagramAdapter lifecycle', () => {
  test('supports polling listener, registers callbacks, and routes inbound', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    const router = makeRouterStub((m) => routed.push(m))
    const adapter = createInstagramAdapter({
      router,
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerCtorResolver: () => ({
        ctor: class {
          constructor() {
            return listener
          }
        } as never,
        transport: 'polling',
      }),
      credentialsStore: {
        getAccount: async () => ({ account_id: 'U_self', username: 'bot', created_at: '', updated_at: '' }),
      },
    })
    await adapter.start()
    listener.connected?.({ userId: 'U_self' })
    expect(adapter.isConnected()).toBe(true)
    expect(router.registered.outbound).toBe(true)
    listener.message?.(msg())
    await waitFor(() => routed.length > 0)
    expect(routed[0]!.workspace).toBe('@instagram-dm')
    await adapter.stop()
    expect(router.registered.outbound).toBe(false)
  })

  test('supports hybrid listener connected payload with transport', async () => {
    const listener = new FakeListener()
    const adapter = createInstagramAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerCtorResolver: () => ({
        ctor: class {
          constructor() {
            return listener
          }
        } as never,
        transport: 'hybrid',
      }),
      credentialsStore: {
        getAccount: async () => ({ account_id: 'U_self', username: 'bot', created_at: '', updated_at: '' }),
      },
    })
    await adapter.start()
    expect(() => listener.connected?.({ userId: 'U_self', transport: 'realtime' })).not.toThrow()
    expect(adapter.isConnected()).toBe(true)
    await adapter.stop()
  })

  test('starts with stored-session login using the metadata account id', async () => {
    const client = fakeClient()
    const adapter = createInstagramAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client,
      listenerCtorResolver: () => ({
        ctor: class {
          constructor() {
            return new FakeListener()
          }
        } as never,
        transport: 'polling',
      }),
      credentialsStore: {
        getAccount: async () => ({ account_id: 'ig-account' }),
      },
    })

    await adapter.start()

    expect(client.loginCalls).toEqual([{ credentials: undefined, accountId: 'ig-account' }])
    await adapter.stop()
  })
})

function makeRouterStub(onRoute: (m: InboundMessage) => void) {
  const registered = { outbound: false, history: false, nameResolver: false }
  return {
    registered,
    route: async (m: InboundMessage) => onRoute(m),
    registerOutbound: () => {
      registered.outbound = true
    },
    unregisterOutbound: () => {
      registered.outbound = false
    },
    registerHistory: () => {
      registered.history = true
    },
    unregisterHistory: () => {
      registered.history = false
    },
    registerChannelNameResolver: () => {
      registered.nameResolver = true
    },
    unregisterChannelNameResolver: () => {
      registered.nameResolver = false
    },
  } as unknown as Parameters<typeof createInstagramAdapter>[0]['router'] & { registered: typeof registered }
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
