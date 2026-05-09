import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import type {
  KakaoChat,
  KakaoMessage,
  KakaoProfile,
  KakaoSendResult,
  KakaoTalkClient,
  KakaoTalkListener,
  KakaoTalkListenerEventMap,
  KakaoTalkPushMessageEvent,
} from './agent-messenger-kakaotalk-shim'
import { createKakaotalkAdapter } from './kakaotalk'

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
  closed = false
  profileResult: KakaoProfile = {
    user_id: '999',
    nickname: 'Self',
    status_message: null,
  }
  chats: KakaoChat[] = []
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
  test('auto-restarts the listener once when KICKOUT arrives within the post-init window', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const logs: Array<{ level: string; msg: string }> = []
    let nowMs = 1_000_000
    const recoveryTasks: Array<{ fn: () => void; delay: number }> = []
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
        recoveryTasks.push({ fn, delay })
      },
    })

    await adapter.start()
    expect(listener.startCalls).toBe(1)

    listener.emit('connected', { userId: '999' })
    expect(adapter.isConnected()).toBe(true)

    // 5 seconds later — well within the 30s post-init window — the SDK
    // emits the KICKOUT error.
    nowMs += 5_000
    listener.emit('error', new Error('Session kicked — another device logged in'))

    expect(adapter.isConnected()).toBe(false)
    expect(recoveryTasks).toHaveLength(1)
    expect(recoveryTasks[0]?.delay).toBeGreaterThan(0)
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('Auto-restarting'))).toBe(true)

    recoveryTasks[0]?.fn()
    expect(listener.startCalls).toBe(2)

    await adapter.stop()
    await router.stop()
  })

  test('does NOT auto-recover when KICKOUT arrives outside the post-init window', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const logs: Array<{ level: string; msg: string }> = []
    let nowMs = 1_000_000
    const recoveryTasks: Array<{ fn: () => void; delay: number }> = []
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
        recoveryTasks.push({ fn, delay })
      },
    })

    await adapter.start()
    listener.emit('connected', { userId: '999' })

    // 5 minutes later — long past the post-init window. This is a real
    // cross-device kick; we must NOT loop-fight.
    nowMs += 5 * 60 * 1000
    listener.emit('error', new Error('Session kicked — another device logged in'))

    expect(adapter.isConnected()).toBe(false)
    expect(recoveryTasks).toHaveLength(0)
    expect(listener.startCalls).toBe(1)
    expect(
      logs.some(
        (l) => l.level === 'error' && l.msg.includes('DEAD after KICKOUT') && l.msg.includes('typeclaw restart'),
      ),
    ).toBe(true)

    await adapter.stop()
    await router.stop()
  })

  test('only attempts auto-recovery once per start() lifecycle', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    let nowMs = 1_000_000
    const recoveryTasks: Array<{ fn: () => void; delay: number }> = []
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
      now: () => nowMs,
      scheduleRecovery: (fn, delay) => {
        recoveryTasks.push({ fn, delay })
      },
    })

    await adapter.start()
    listener.emit('connected', { userId: '999' })

    nowMs += 1_000
    listener.emit('error', new Error('Session kicked — another device logged in'))
    expect(recoveryTasks).toHaveLength(1)

    // Pretend the recovery ran and we reconnected, then got kicked again
    // immediately. The second KICKOUT must NOT re-arm recovery.
    recoveryTasks[0]?.fn()
    listener.emit('connected', { userId: '999' })
    nowMs += 1_000
    listener.emit('error', new Error('Session kicked — another device logged in'))

    expect(recoveryTasks).toHaveLength(1)

    await adapter.stop()
    await router.stop()
  })

  test('non-KICKOUT errors do not trigger recovery and do not flip connected', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const recoveryTasks: Array<{ fn: () => void; delay: number }> = []
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
      scheduleRecovery: (fn, delay) => {
        recoveryTasks.push({ fn, delay })
      },
    })

    await adapter.start()
    listener.emit('connected', { userId: '999' })
    expect(adapter.isConnected()).toBe(true)

    listener.emit('error', new Error('socket closed unexpectedly'))

    expect(recoveryTasks).toHaveLength(0)
    // Generic errors don't flip connected — the SDK's own reconnect path
    // owns disconnection state via the 'disconnected' event.
    expect(adapter.isConnected()).toBe(true)

    await adapter.stop()
    await router.stop()
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
      { chat_id: '222', type: 10, display_name: 'Team', active_members: 5, unread_count: 0, last_message: null },
    ]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '222',
      log_id: 'L99',
      author_id: 1,
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
      { chat_id: '111', type: 0, display_name: 'Other', active_members: 2, unread_count: 0, last_message: null },
    ]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    const event: KakaoTalkPushMessageEvent = {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L42',
      author_id: 999,
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
