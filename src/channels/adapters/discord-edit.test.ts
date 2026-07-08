import { describe, expect, it } from 'bun:test'

import type { EditMessageRequest } from '@/channels/types'

import { createDiscordUserEditMessageCallback } from './discord-edit'

class FakeDiscordError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

const req = (over: Partial<EditMessageRequest> = {}): EditMessageRequest => ({
  adapter: 'discord',
  workspace: 'G1',
  chat: '111',
  thread: null,
  messageId: '222',
  text: 'edited body',
  ...over,
})

describe('createDiscordUserEditMessageCallback', () => {
  it('calls editMessage with (channelId, messageId, content) and returns ok', async () => {
    const calls: Array<{ channelId: string; messageId: string; content: string }> = []
    const cb = createDiscordUserEditMessageCallback({
      client: {
        editMessage: async (channelId, messageId, content) => {
          calls.push({ channelId, messageId, content })
          return { id: messageId, content } as never
        },
      },
    })

    const result = await cb(req())

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ channelId: '111', messageId: '222', content: 'edited body' }])
  })

  it('patches the thread channel id, not the parent chat, when the message is in a thread', async () => {
    const calls: Array<{ channelId: string; messageId: string; content: string }> = []
    const cb = createDiscordUserEditMessageCallback({
      client: {
        editMessage: async (channelId, messageId, content) => {
          calls.push({ channelId, messageId, content })
          return { id: messageId, content } as never
        },
      },
    })

    const result = await cb(req({ chat: '111', thread: '999', messageId: '222' }))

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ channelId: '999', messageId: '222', content: 'edited body' }])
  })

  it('rejects a mismatched adapter as not-supported', async () => {
    const cb = createDiscordUserEditMessageCallback({
      client: { editMessage: async () => ({}) as never },
    })

    const result = await cb(req({ adapter: 'discord-bot' }))

    expect(result).toEqual({ ok: false, error: 'unknown adapter: discord-bot', code: 'not-supported' })
  })

  it('maps 50005 (editing another user message) to permission-denied', async () => {
    const cb = createDiscordUserEditMessageCallback({
      client: {
        editMessage: async () => {
          throw new FakeDiscordError('50005')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('permission-denied')
  })

  it('maps 10008 (unknown message) to not-found', async () => {
    const cb = createDiscordUserEditMessageCallback({
      client: {
        editMessage: async () => {
          throw new FakeDiscordError('10008')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-found')
  })

  it('maps http_403 (forbidden) to permission-denied', async () => {
    const cb = createDiscordUserEditMessageCallback({
      client: {
        editMessage: async () => {
          throw new FakeDiscordError('http_403')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('permission-denied')
  })
})
