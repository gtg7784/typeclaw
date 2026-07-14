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

describe('createKakaoTypingCallback', () => {
  test('phase=tick sends an ACTION packet for the chat', async () => {
    const calls: Array<{ chatId: string; opts?: { linkId?: string } }> = []
    const callback = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId, opts) => {
        calls.push({ chatId, ...(opts !== undefined ? { opts } : {}) })
        return ok(chatId)
      },
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(calls).toEqual([{ chatId: 'chat-1' }])
  })

  test('phase=stop does NOT send an ACTION packet (KakaoTalk auto-expires; no stop API)', async () => {
    const calls: string[] = []
    const callback = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'stop' })

    expect(calls).toEqual([])
  })

  test('ignores targets for other adapters', async () => {
    let called = false
    const callback = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        called = true
        return ok(chatId)
      },
    })

    await callback({ adapter: 'webex', workspace: 'webex', chat: 'room-1', thread: null, phase: 'tick' })

    expect(called).toBe(false)
  })

  test('swallows sendTyping transport failures and logs a warning rather than throwing', async () => {
    const log = logger()
    const callback = createKakaoTypingCallback({
      logger: log,
      sendTyping: async () => {
        throw new Error('loco disconnected')
      },
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(log.lines.some((l) => l.startsWith('warn:[kakaotalk:typing]') && l.includes('loco disconnected'))).toBe(true)
  })

  test('logs a warning when the ACTION packet is rejected (non-zero status_code)', async () => {
    const log = logger()
    const callback = createKakaoTypingCallback({
      logger: log,
      sendTyping: async (chatId) => ({ success: false, status_code: -1, chat_id: chatId }),
    })

    await callback({ adapter: 'kakaotalk', workspace: 'bucket', chat: 'chat-1', thread: null, phase: 'tick' })

    expect(log.lines.some((l) => l.startsWith('warn:[kakaotalk:typing]') && l.includes('status_code=-1'))).toBe(true)
  })

  test('uses formatChannelTag for the warning label when provided', async () => {
    const log = logger()
    const callback = createKakaoTypingCallback({
      logger: log,
      sendTyping: async () => {
        throw new Error('boom')
      },
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
    const callback = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        const id = `t${++n}`
        if (id === 't1') await gate
        completed.push(id)
        return ok(chatId)
      },
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
    const callback = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        if (chatId === 'chat-A') await gateA
        order.push(chatId)
        return ok(chatId)
      },
    })

    const a = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-A', thread: null, phase: 'tick' })
    const b = callback({ adapter: 'kakaotalk', workspace: 'b', chat: 'chat-B', thread: null, phase: 'tick' })
    await b
    releaseA?.()
    await a

    expect(order).toEqual(['chat-B', 'chat-A'])
  })

  test('skips typing for @kakao-open (linkId unsupported) and logs once per chat', async () => {
    const calls: string[] = []
    const log = logger()
    const callback = createKakaoTypingCallback({
      logger: log,
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
    })

    await callback({ adapter: 'kakaotalk', workspace: '@kakao-open', chat: 'open-1', thread: null, phase: 'tick' })
    await callback({ adapter: 'kakaotalk', workspace: '@kakao-open', chat: 'open-1', thread: null, phase: 'tick' })

    expect(calls).toEqual([])
    expect(log.lines.filter((l) => l.includes('open_chat_link_id_unsupported'))).toHaveLength(1)
  })

  test('still emits for @kakao-group and @kakao-dm', async () => {
    const calls: string[] = []
    const callback = createKakaoTypingCallback({
      logger: logger(),
      sendTyping: async (chatId) => {
        calls.push(chatId)
        return ok(chatId)
      },
    })

    await callback({ adapter: 'kakaotalk', workspace: '@kakao-group', chat: 'grp-1', thread: null, phase: 'tick' })
    await callback({ adapter: 'kakaotalk', workspace: '@kakao-dm', chat: 'dm-1', thread: null, phase: 'tick' })

    expect(calls).toEqual(['grp-1', 'dm-1'])
  })
})
