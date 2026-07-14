import { describe, expect, test } from 'bun:test'

import type { KakaoTypingResult } from 'agent-messenger/kakaotalk'

import { createKakaoTypingCallback, type KakaoTypingLogger } from './kakaotalk-typing'

const logger = (): KakaoTypingLogger & { lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    info: (m) => void lines.push(`info:${m}`),
    warn: (m) => void lines.push(`warn:${m}`),
    error: (m) => void lines.push(`error:${m}`),
  }
}

const ok = (chatId: string): KakaoTypingResult => ({ success: true, status_code: 0, chat_id: chatId })

// A no-op interval seam so `tick` doesn't schedule a real self-refresh timer
// during unit tests. The refresh path is exercised explicitly below.
const noRefresh = { setInterval: () => 0 as unknown, clearInterval: () => {} }

describe('createKakaoTypingCallback', () => {
  test('phase=tick sends an ACTION packet for the chat', async () => {
    const calls: Array<{ chatId: string; opts?: { linkId?: string } }> = []
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId, opts) => {
        calls.push({ chatId, ...(opts !== undefined ? { opts } : {}) })
        return ok(chatId)
      },
      ...noRefresh,
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(calls).toEqual([{ chatId: 'chat-1' }])
  })

  test('phase=stop does NOT send an ACTION packet (KakaoTalk auto-expires on message)', async () => {
    const calls: string[] = []
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      ...noRefresh,
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'stop' })

    expect(calls).toEqual([])
  })

  test('ignores targets for other adapters', async () => {
    let called = false
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        called = true
        return ok(chatId)
      },
      ...noRefresh,
    })

    await callback({ adapter: 'webex', workspace: 'webex', chat: 'room-1', thread: null, phase: 'tick' })

    expect(called).toBe(false)
  })

  test('swallows sendTyping transport failures and logs a warning rather than throwing', async () => {
    const log = logger()
    const { callback } = createKakaoTypingCallback({
      logger: log,
      sendTyping: async () => {
        throw new Error('loco disconnected')
      },
      ...noRefresh,
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(log.lines.some((l) => l.startsWith('warn:[kakaotalk:typing]') && l.includes('loco disconnected'))).toBe(true)
  })

  test('logs a warning when the ACTION packet is rejected (non-zero status_code)', async () => {
    const log = logger()
    const { callback } = createKakaoTypingCallback({
      logger: log,
      sendTyping: async (chatId) => ({ success: false, status_code: -1, chat_id: chatId }),
      ...noRefresh,
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(log.lines.some((l) => l.startsWith('warn:[kakaotalk:typing]') && l.includes('status_code=-1'))).toBe(true)
  })

  test('uses formatChannelTag for the warning label when provided', async () => {
    const log = logger()
    const { callback } = createKakaoTypingCallback({
      logger: log,
      sendTyping: async () => {
        throw new Error('boom')
      },
      formatChannelTag: async (workspace, chat) => `bucket=${workspace} chat=#가족방(${chat})`,
      ...noRefresh,
    })

    await callback({ adapter: 'kakaotalk', workspace: 'home', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(log.lines.some((l) => l.includes('chat=#가족방(chat-1)'))).toBe(true)
  })

  test('serializes per-chat so a slow tick still completes before the next enqueue (FIFO order on the wire)', async () => {
    const completed: string[] = []
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let n = 0
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        const id = `t${++n}`
        if (id === 't1') await gate
        completed.push(id)
        return ok(chatId)
      },
      ...noRefresh,
    })

    const first = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    const second = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    releaseFirst?.()
    await Promise.all([first, second])

    expect(completed).toEqual(['t1', 't2'])
  })

  test('does not serialize across distinct chats', async () => {
    const order: string[] = []
    let releaseA: (() => void) | undefined
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        if (chatId === 'chat-A') await gateA
        order.push(chatId)
        return ok(chatId)
      },
      ...noRefresh,
    })

    const a = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-A', thread: null, phase: 'tick' })
    const b = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-B', thread: null, phase: 'tick' })
    await b
    releaseA?.()
    await a

    expect(order).toEqual(['chat-B', 'chat-A'])
  })

  test('tick starts a self-refresh timer that re-fires ACTION; stop clears it', async () => {
    const calls: string[] = []
    let refreshFn: (() => void) | undefined
    let cleared = false
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      setInterval: (fn) => {
        refreshFn = fn
        return 'handle'
      },
      clearInterval: (handle) => {
        if (handle === 'handle') cleared = true
      },
    })

    await callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    expect(calls).toEqual(['chat-1'])

    // simulate the refresh interval firing between router heartbeats
    refreshFn?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['chat-1', 'chat-1'])

    await callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'stop' })
    expect(cleared).toBe(true)

    // a fired-but-cleared timer must not enqueue again
    refreshFn?.()
    await Promise.resolve()
    expect(calls).toEqual(['chat-1', 'chat-1'])
  })

  test('shutdown clears every outstanding refresh timer', async () => {
    const cleared: string[] = []
    let handleSeq = 0
    const { callback, shutdown } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => ok(chatId),
      setInterval: () => `handle-${++handleSeq}`,
      clearInterval: (handle) => void cleared.push(handle as string),
    })

    await callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    await callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-2', thread: null, phase: 'tick' })

    shutdown()

    expect(cleared.sort()).toEqual(['handle-1', 'handle-2'])
  })

  test('a refresh queued behind an in-flight send is dropped once stop lands (only the in-flight packet ships)', async () => {
    const completed: string[] = []
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let n = 0
    let refreshFn: (() => void) | undefined
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        const id = `send${++n}`
        if (id === 'send1') await gate
        completed.push(id)
        return ok(chatId)
      },
      setInterval: (fn) => {
        refreshFn = fn
        return 'handle'
      },
      clearInterval: () => {},
    })

    // given: send1 has already passed the generation gate and is stalled mid-flight on the wire
    const tick = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    await flush()
    // when: the refresh timer queues send2 behind the in-flight send1, then stop lands before send1 resolves
    refreshFn?.()
    await callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'stop' })
    releaseFirst?.()
    await tick
    await flush()

    // then: send1 (already on the wire) ships, but the queued send2 is dropped by the generation gate
    expect(completed).toEqual(['send1'])
  })

  test('skips typing for @kakao-open (linkId unsupported) and logs once per chat', async () => {
    const calls: string[] = []
    const log = logger()
    const { callback } = createKakaoTypingCallback({
      logger: log,
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      ...noRefresh,
    })

    await callback({ adapter: 'kakaotalk', workspace: '@kakao-open', chat: 'open-1', thread: null, phase: 'tick' })
    await callback({ adapter: 'kakaotalk', workspace: '@kakao-open', chat: 'open-1', thread: null, phase: 'tick' })

    expect(calls).toEqual([])
    expect(log.lines.filter((l) => l.includes('open_chat_link_id_unsupported'))).toHaveLength(1)
  })

  test('still emits for @kakao-group and @kakao-dm', async () => {
    const calls: string[] = []
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      ...noRefresh,
    })

    await callback({ adapter: 'kakaotalk', workspace: '@kakao-group', chat: 'grp-1', thread: null, phase: 'tick' })
    await callback({ adapter: 'kakaotalk', workspace: '@kakao-dm', chat: 'dm-1', thread: null, phase: 'tick' })

    expect(calls).toEqual(['grp-1', 'dm-1'])
  })
})
