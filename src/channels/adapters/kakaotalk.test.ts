import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  KakaoChat,
  KakaoMember,
  KakaoMessage,
  KakaoProfile,
  KakaoSendResult,
  KakaoTalkListenerEventMap,
  KakaoTalkPushMessageEvent,
} from 'agent-messenger/kakaotalk'

import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import { createKakaotalkAdapter, type KakaoTalkClient, type KakaoTalkListener } from './kakaotalk'

type EventKey = keyof KakaoTalkListenerEventMap

class FakeListener implements KakaoTalkListener {
  startThrows: Error | null = null
  startCalls = 0
  stopCalls = 0
  private handlers: Partial<Record<EventKey, Array<(...args: never[]) => void>>> = {}

  async start(): Promise<void> {
    this.startCalls++
    if (this.startThrows !== null) throw this.startThrows
  }

  stop(): void {
    this.stopCalls++
  }

  on<K extends EventKey>(event: K, listener: (...args: KakaoTalkListenerEventMap[K]) => void): this {
    const list = (this.handlers[event] ?? []) as Array<(...args: never[]) => void>
    list.push(listener as (...args: never[]) => void)
    this.handlers[event] = list
    return this
  }

  off<K extends EventKey>(event: K, listener: (...args: KakaoTalkListenerEventMap[K]) => void): this {
    const list = this.handlers[event]
    if (list) {
      const idx = list.indexOf(listener as (...args: never[]) => void)
      if (idx !== -1) list.splice(idx, 1)
    }
    return this
  }

  emit<K extends EventKey>(event: K, ...args: KakaoTalkListenerEventMap[K]): void {
    const list = this.handlers[event] ?? []
    for (const fn of list) (fn as (...args: KakaoTalkListenerEventMap[K]) => void)(...args)
  }
}

class FakeClient implements KakaoTalkClient {
  loginCalls = 0
  sendMessageCalls: Array<{ chatId: string; text: string }> = []
  getMessagesCalls: Array<{ chatId: string; opts?: { count?: number; from?: string } }> = []
  getMembersCalls: string[] = []
  closed = false
  profileResult: KakaoProfile = {
    user_id: '999',
    nickname: 'Self',
    profile_image_url: null,
    original_profile_image_url: null,
    status_message: null,
    account_display_id: null,
  }
  chats: KakaoChat[] = []
  membersByChat: Map<string, KakaoMember[]> = new Map()
  inlineNamesByChat: Map<string, Map<number, string>> = new Map()
  getMembersError: Error | null = null
  sendResult: KakaoSendResult = { success: true, status_code: 0, chat_id: '111', log_id: 'L1', sent_at: 0 }

  async login(): Promise<this> {
    this.loginCalls++
    return this
  }

  async getChats(): Promise<KakaoChat[]> {
    return this.chats
  }

  async getMessages(chatId: string, opts?: { count?: number; from?: string }): Promise<KakaoMessage[]> {
    this.getMessagesCalls.push({ chatId, ...(opts !== undefined ? { opts } : {}) })
    return []
  }

  async sendMessage(chatId: string, text: string): Promise<KakaoSendResult> {
    this.sendMessageCalls.push({ chatId, text })
    return this.sendResult
  }

  async getProfile(): Promise<KakaoProfile> {
    return this.profileResult
  }

  async getMembers(chatId: string): Promise<KakaoMember[]> {
    this.getMembersCalls.push(chatId)
    if (this.getMembersError !== null) throw this.getMembersError
    return this.membersByChat.get(chatId) ?? []
  }

  lookupAuthorName(chatId: string, authorId: number): string | null {
    return this.inlineNamesByChat.get(chatId)?.get(authorId) ?? null
  }

  close(): void {
    this.closed = true
  }
}

const adapterCfg = (over: Partial<ChannelAdapterConfig> = {}): ChannelAdapterConfig => ({
  allow: ['kakao:*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
  ...over,
})

let agentDir: string
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-adapter-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('createKakaotalkAdapter — start/stop lifecycle', () => {
  test('login + getProfile + listener.start are called in order', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })

    await adapter.start()

    expect(client.loginCalls).toBe(1)
    expect(listener.startCalls).toBe(1)
    expect(adapter.isConnected()).toBe(false)

    listener.emit('connected', { userId: '999' })
    expect(adapter.isConnected()).toBe(true)

    await adapter.stop()
    expect(listener.stopCalls).toBe(1)
    expect(client.closed).toBe(true)
    expect(adapter.isConnected()).toBe(false)

    await router.stop()
  })

  test('does NOT register router callbacks when listener.start() throws', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    listener.startThrows = new Error('socket refused')
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })

    await expect(adapter.start()).rejects.toThrow('socket refused')

    // The router should not hold any kakaotalk callbacks. Easiest way to
    // assert this without poking router internals: send an outbound
    // through the router and verify no callback fires (the send returns
    // an error rather than reaching our fake client).
    const send = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'hi',
    })
    expect(send.ok).toBe(false)
    expect(client.sendMessageCalls).toHaveLength(0)

    await router.stop()
  })

  test('stop() is a no-op when start() never succeeded', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    listener.startThrows = new Error('boom')
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })

    await expect(adapter.start()).rejects.toThrow()
    await adapter.stop()
    expect(listener.stopCalls).toBe(0)

    await router.stop()
  })
})

describe('createKakaotalkAdapter — outbound', () => {
  test('returns ok:true and forwards text when no attachments', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    const result = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'hello',
    })
    expect(result.ok).toBe(true)
    expect(client.sendMessageCalls).toEqual([{ chatId: '111', text: 'hello' }])

    await adapter.stop()
    await router.stop()
  })

  test('returns ok:false (and does NOT send) when attachments are present', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()

    const result = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'hi',
      attachments: [{ path: '/tmp/some-file.png' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('does not support attachments')
    // The agent contract violation Oracle flagged: text MUST NOT have been
    // sent if we report failure. Otherwise the agent would say "I sent your
    // message" while the file silently disappeared.
    expect(client.sendMessageCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })

  test('returns ok:false when allow rules deny the chat', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({
      agentDir,
      configForAdapter: () => adapterCfg({ allow: ['kakao:dm/*'] }),
    })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg({ allow: ['kakao:dm/*'] }),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()

    const result = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-group',
      chat: '222',
      text: 'leak',
    })
    expect(result.ok).toBe(false)
    expect(client.sendMessageCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })
})

describe('createKakaotalkAdapter — KICKOUT recovery', () => {
  type ScheduledTask = { fn: () => void; delay: number }
  type RecoveryHarness = {
    listener: FakeListener
    adapter: ReturnType<typeof createKakaotalkAdapter>
    router: ReturnType<typeof createChannelRouter>
    logs: Array<{ level: string; msg: string }>
    tasks: ScheduledTask[]
    advance: (ms: number) => void
    nowMs: () => number
  }

  const buildHarness = (agentDirArg: string): RecoveryHarness => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir: agentDirArg, configForAdapter: () => adapterCfg() })
    const logs: Array<{ level: string; msg: string }> = []
    const tasks: ScheduledTask[] = []
    let nowMs = 1_000_000
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
      logger: {
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'error', msg }),
      },
      now: () => nowMs,
      scheduleRecovery: (fn, delay) => {
        tasks.push({ fn, delay })
      },
    })
    return {
      listener,
      adapter,
      router,
      logs,
      tasks,
      advance: (ms) => {
        nowMs += ms
      },
      nowMs: () => nowMs,
    }
  }

  test('starts a recovery episode on a KICKOUT inside the post-init window and reconnects with the first delay', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    expect(h.listener.startCalls).toBe(1)

    h.listener.emit('connected', { userId: '999' })
    expect(h.adapter.isConnected()).toBe(true)

    h.advance(5_000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))

    expect(h.adapter.isConnected()).toBe(false)
    const reconnect = h.tasks.find((t) => t.delay === 2_000)
    expect(reconnect).toBeDefined()
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('attempt 1/3'))).toBe(true)

    reconnect?.fn()
    expect(h.listener.startCalls).toBe(2)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('survives ghost-session ping-pong by retrying with growing delays before giving up', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })

    const kick = (): void => h.listener.emit('error', new Error('Session kicked — another device logged in'))

    const expectedDelays = [2_000, 10_000, 60_000] as const
    for (const [i, delay] of expectedDelays.entries()) {
      h.advance(1_000)
      kick()
      const reconnect = h.tasks.at(-1)
      expect(reconnect?.delay).toBe(delay)
      h.advance(delay)
      reconnect?.fn()
      expect(h.listener.startCalls).toBe(i + 2)
      h.listener.emit('connected', { userId: '999' })
    }

    h.advance(1_000)
    kick()
    expect(h.listener.startCalls).toBe(expectedDelays.length + 1)
    expect(
      h.logs.some(
        (l) =>
          l.level === 'error' &&
          l.msg.includes('DEAD after KICKOUT') &&
          (l.msg.includes('attempt(s) exhausted') || l.msg.includes('budget exhausted')),
      ),
    ).toBe(true)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('gives up with budget-exhausted reason when stalled retries push past the wall-clock cap', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })

    const kick = (): void => h.listener.emit('error', new Error('Session kicked — another device logged in'))

    // Two quick KICKOUTs consume attempts 1 and 2 (delays 2_000 and
    // 10_000), then we sit at the recovered listener for ~4.5 minutes
    // before a third KICKOUT arrives. The third attempt's 60_000 delay
    // would push elapsed-in-episode past the 300_000 cap, so we should
    // give up via the budget branch rather than scheduling attempt 3.
    h.advance(1_000)
    kick()
    const reconnect1 = h.tasks.at(-1)
    h.advance(2_000)
    reconnect1?.fn()
    h.listener.emit('connected', { userId: '999' })

    h.advance(1_000)
    kick()
    const reconnect2 = h.tasks.at(-1)
    h.advance(10_000)
    reconnect2?.fn()
    h.listener.emit('connected', { userId: '999' })

    const tasksBeforeStallKick = h.tasks.length
    h.advance(4 * 60 * 1000 + 30_000)
    kick()

    expect(h.tasks.length).toBe(tasksBeforeStallKick)
    expect(h.logs.some((l) => l.level === 'error' && l.msg.includes('budget exhausted'))).toBe(true)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('a stable recovered connection ends the episode and re-arms recovery for a much-later KICKOUT', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })

    h.advance(5_000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))
    const reconnect = h.tasks.at(-1)
    expect(reconnect?.delay).toBe(2_000)
    h.advance(2_000)
    reconnect?.fn()
    expect(h.listener.startCalls).toBe(2)

    h.listener.emit('connected', { userId: '999' })
    const stabilityCheck = h.tasks.at(-1)
    expect(stabilityCheck?.delay).toBe(60_000)
    h.advance(60_000)
    stabilityCheck?.fn()

    expect(h.logs.some((l) => l.level === 'info' && l.msg.includes('recovery episode succeeded'))).toBe(true)

    const tasksBeforeFreshKick = h.tasks.length
    h.advance(10 * 60 * 1000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))
    const freshReconnect = h.tasks.at(-1)
    expect(h.tasks.length).toBe(tasksBeforeFreshKick + 1)
    expect(freshReconnect?.delay).toBe(2_000)
    const attemptOneLogs = h.logs.filter((l) => l.level === 'warn' && l.msg.includes('attempt 1/3'))
    expect(attemptOneLogs.length).toBe(2)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('a brief reconnect that gets kicked again does NOT count as episode success', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })

    h.advance(5_000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))
    const reconnect = h.tasks.at(-1)
    expect(reconnect?.delay).toBe(2_000)
    h.advance(2_000)
    reconnect?.fn()
    h.listener.emit('connected', { userId: '999' })
    const stabilityCheck = h.tasks.at(-1)
    expect(stabilityCheck?.delay).toBe(60_000)

    h.advance(1_000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))

    h.advance(60_000)
    stabilityCheck?.fn()
    expect(h.logs.some((l) => l.msg.includes('recovery episode succeeded'))).toBe(false)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('non-KICKOUT errors do not start a recovery episode or flip connected', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })
    expect(h.adapter.isConnected()).toBe(true)

    h.listener.emit('error', new Error('socket closed unexpectedly'))

    expect(h.tasks).toHaveLength(0)
    expect(h.adapter.isConnected()).toBe(true)

    await h.adapter.stop()
    await h.router.stop()
  })
})

describe('createKakaotalkAdapter — drop hint', () => {
  test('not_in_allow_list hint suggests bucket-specific patterns', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({
      agentDir,
      configForAdapter: () => adapterCfg({ allow: ['kakao:dm/*'] }),
    })
    const logs: string[] = []
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg({ allow: ['kakao:dm/*'] }),
      client,
      listenerFactory: () => listener,
      logger: {
        info: (m) => logs.push(m),
        warn: () => {},
        error: () => {},
      },
    })
    // Group chat (5 members → group bucket regardless of LOCO type code).
    client.chats = [
      {
        chat_id: '222',
        type: 10,
        display_name: 'Team',
        title: null,
        active_members: 5,
        unread_count: 0,
        last_message: null,
      },
    ]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '222',
      log_id: 'L99',
      author_id: 1,
      author_name: null,
      message: 'hi',
      message_type: 1,
      sent_at: Date.now(),
    })

    await new Promise((r) => setTimeout(r, 0))

    const drop = logs.find((m) => m.includes('reason=not_in_allow_list'))
    expect(drop).toBeDefined()
    expect(drop).toContain('kakao:group/*')
    expect(drop).toContain('kakao:222')

    await adapter.stop()
    await router.stop()
  })
})

describe('createKakaotalkAdapter — author name resolution', () => {
  const groupChat = (id: string, members: number): KakaoChat => ({
    chat_id: id,
    type: 10,
    display_name: 'Team',
    title: null,
    active_members: members,
    unread_count: 0,
    last_message: null,
  })

  const buildMember = (user_id: string, nickname: string): KakaoMember => ({
    user_id,
    nickname,
    profile_image_url: null,
    full_profile_image_url: null,
    original_profile_image_url: null,
    status_message: null,
    country_iso: null,
    user_type: 100,
    open_token: null,
    open_profile_link_id: null,
    open_permission: null,
  })

  test('uses event.author_name (free PR #187 path) without firing GETMEM', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [groupChat('111', 4)]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L42',
      author_id: 222,
      author_name: 'Alice',
      message: 'hello',
      message_type: 1,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(client.getMembersCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })

  test('falls back to GETMEM when event.author_name is null', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [groupChat('111', 50)]
    client.membersByChat.set('111', [buildMember('222', 'Bob')])
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L77',
      author_id: 222,
      author_name: null,
      message: 'hi from a non-display member',
      message_type: 1,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(client.getMembersCalls).toEqual(['111'])

    await adapter.stop()
    await router.stop()
  })

  test('does not fire GETMEM for self-author drops', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [groupChat('111', 50)]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L01',
      author_id: 999,
      author_name: null,
      message: 'self message',
      message_type: 1,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(client.getMembersCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })
})

describe('createKakaotalkAdapter — inbound classification', () => {
  test('drops self_author when author equals authenticated user_id', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [
      {
        chat_id: '111',
        type: 0,
        display_name: 'Other',
        title: null,
        active_members: 2,
        unread_count: 0,
        last_message: null,
      },
    ]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    const event: KakaoTalkPushMessageEvent = {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L42',
      author_id: 999,
      author_name: null,
      message: 'hi',
      message_type: 1,
      sent_at: Date.now(),
    }
    listener.emit('message', event)

    // Give the async handler a turn.
    await new Promise((r) => setTimeout(r, 0))

    expect(client.sendMessageCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })
})
