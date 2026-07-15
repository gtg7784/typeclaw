import { describe, expect, test } from 'bun:test'

import type { KakaoTypingResult } from 'agent-messenger/kakaotalk'

import {
  createKakaoTypingCallback,
  kakaoTypingClassFromLookup,
  type KakaoTypingChatClass,
  type KakaoTypingLogger,
} from './kakaotalk-typing'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

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

// Default classifier: every chat sends. Tests that exercise OpenChat skip or
// unknown-chat suppression pass their own.
const sendAll = (): KakaoTypingChatClass => 'send'

describe('kakaoTypingClassFromLookup', () => {
  test('null (unknown) → skip-unresolved', () => {
    expect(kakaoTypingClassFromLookup(null)).toBe('skip-unresolved')
  })
  test('provisional entry → send (inbound push proves the chat is real; @kakao-group bucket, never open)', () => {
    expect(kakaoTypingClassFromLookup({ workspace: '@kakao-group', provisional: true })).toBe('send')
  })
  test('authoritative @kakao-open → skip-open', () => {
    expect(kakaoTypingClassFromLookup({ workspace: '@kakao-open', provisional: false })).toBe('skip-open')
  })
  test('authoritative @kakao-group / @kakao-dm → send', () => {
    expect(kakaoTypingClassFromLookup({ workspace: '@kakao-group', provisional: false })).toBe('send')
    expect(kakaoTypingClassFromLookup({ workspace: '@kakao-dm', provisional: false })).toBe('send')
  })
})

describe('createKakaoTypingCallback', () => {
  test('phase=tick sends an ACTION packet for the chat', async () => {
    const calls: Array<{ chatId: string; opts?: { linkId?: string } }> = []
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId, opts) => {
        calls.push({ chatId, ...(opts !== undefined ? { opts } : {}) })
        return ok(chatId)
      },
      classifyChat: sendAll,
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(calls).toEqual([{ chatId: 'chat-1' }])
  })

  test('phase=stop does NOT send an ACTION packet (KakaoTalk auto-expires; no stop API)', async () => {
    const calls: string[] = []
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      classifyChat: sendAll,
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
      classifyChat: sendAll,
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
      classifyChat: sendAll,
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(log.lines.some((l) => l.startsWith('warn:[kakaotalk:typing]') && l.includes('loco disconnected'))).toBe(true)
  })

  test('logs a warning when the ACTION packet is rejected (non-zero status_code)', async () => {
    const log = logger()
    const { callback } = createKakaoTypingCallback({
      logger: log,
      sendTyping: async (chatId) => ({ success: false, status_code: -1, chat_id: chatId }),
      classifyChat: sendAll,
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
      classifyChat: sendAll,
      formatChannelTag: async (workspace, chat) => `bucket=${workspace} chat=#가족방(${chat})`,
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
      classifyChat: sendAll,
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
      classifyChat: sendAll,
    })

    const a = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-A', thread: null, phase: 'tick' })
    const b = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-B', thread: null, phase: 'tick' })
    await b
    releaseA?.()
    await a

    expect(order).toEqual(['chat-B', 'chat-A'])
  })

  test('skips typing for a confirmed OpenChat (skip-open) and logs once per chat', async () => {
    const calls: string[] = []
    const log = logger()
    const { callback } = createKakaoTypingCallback({
      logger: log,
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      classifyChat: () => 'skip-open',
    })

    await callback({ adapter: 'kakaotalk', workspace: '@kakao-open', chat: 'open-1', thread: null, phase: 'tick' })
    await callback({ adapter: 'kakaotalk', workspace: '@kakao-open', chat: 'open-1', thread: null, phase: 'tick' })

    expect(calls).toEqual([])
    expect(log.lines.filter((l) => l.includes('open_chat_link_id_unsupported'))).toHaveLength(1)
  })

  test('skips typing for an unknown chat (skip-unresolved) silently — no packet, no log', async () => {
    const calls: string[] = []
    const log = logger()
    const { callback } = createKakaoTypingCallback({
      logger: log,
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      classifyChat: () => 'skip-unresolved',
    })

    await callback({ adapter: 'kakaotalk', workspace: '@kakao-group', chat: 'unknown-1', thread: null, phase: 'tick' })

    expect(calls).toEqual([])
    expect(log.lines).toEqual([])
  })

  test('classifies live at each tick: a chat suppressed while unresolved sends once it resolves', async () => {
    const calls: string[] = []
    let cls: KakaoTypingChatClass = 'skip-unresolved'
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      classifyChat: () => cls,
    })

    await callback({ adapter: 'kakaotalk', workspace: '@kakao-group', chat: 'c1', thread: null, phase: 'tick' })
    expect(calls).toEqual([])

    cls = 'send'
    await callback({ adapter: 'kakaotalk', workspace: '@kakao-group', chat: 'c1', thread: null, phase: 'tick' })
    expect(calls).toEqual(['c1'])
  })

  test('still emits for authoritative @kakao-group and @kakao-dm', async () => {
    const calls: string[] = []
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
      classifyChat: sendAll,
    })

    await callback({ adapter: 'kakaotalk', workspace: '@kakao-group', chat: 'grp-1', thread: null, phase: 'tick' })
    await callback({ adapter: 'kakaotalk', workspace: '@kakao-dm', chat: 'dm-1', thread: null, phase: 'tick' })

    expect(calls).toEqual(['grp-1', 'dm-1'])
  })

  test('a tick queued behind an in-flight send is dropped once a stop lands (only the in-flight packet ships)', async () => {
    const completed: string[] = []
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let n = 0
    const { callback } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        const id = `send${++n}`
        if (id === 'send1') await gate
        completed.push(id)
        return ok(chatId)
      },
      classifyChat: sendAll,
    })

    // given: tick 1 has passed the generation gate and is stalled mid-flight
    const first = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    await flush()
    // when: tick 2 queues behind the in-flight send1, then stop lands before send1 resolves
    const second = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    await callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'stop' })
    releaseFirst?.()
    await Promise.all([first, second])
    await flush()

    // then: send1 ships (already on the wire); the queued send2 is dropped by the generation gate
    expect(completed).toEqual(['send1'])
  })

  test('reset() drops a tick queued behind an in-flight send (adapter shutdown path)', async () => {
    const completed: string[] = []
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let n = 0
    const { callback, reset } = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        const id = `send${++n}`
        if (id === 'send1') await gate
        completed.push(id)
        return ok(chatId)
      },
      classifyChat: sendAll,
    })

    const first = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    await flush()
    const second = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-1', thread: null, phase: 'tick' })
    reset()
    releaseFirst?.()
    await Promise.all([first, second])
    await flush()

    expect(completed).toEqual(['send1'])
  })
})
