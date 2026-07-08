import { describe, expect, it } from 'bun:test'

import type { EditMessageRequest } from '@/channels/types'

import { createSlackEditMessageCallback } from './slack-bot-edit'

class FakeSlackError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

const req = (over: Partial<EditMessageRequest> = {}): EditMessageRequest => ({
  adapter: 'slack-bot',
  workspace: 'T1',
  chat: 'C1',
  thread: null,
  messageId: '1700000000.000100',
  text: 'edited body',
  ...over,
})

describe('createSlackEditMessageCallback', () => {
  it('calls updateMessage with (channel, ts, text) and returns ok', async () => {
    const calls: Array<{ channel: string; ts: string; text: string }> = []
    const cb = createSlackEditMessageCallback({
      client: {
        updateMessage: async (channel, ts, text) => {
          calls.push({ channel, ts, text })
          return { ts, text, type: 'message' }
        },
      },
    })

    const result = await cb(req())

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ channel: 'C1', ts: '1700000000.000100', text: 'edited body' }])
  })

  it('rejects a mismatched adapter as not-supported', async () => {
    const cb = createSlackEditMessageCallback({
      client: { updateMessage: async () => ({ ts: 'x', text: 'x', type: 'message' }) },
    })

    const result = await cb(req({ adapter: 'discord-bot' }))

    expect(result).toEqual({ ok: false, error: 'unknown adapter: discord-bot', code: 'not-supported' })
  })

  it('maps message_not_found to not-found', async () => {
    const cb = createSlackEditMessageCallback({
      client: {
        updateMessage: async () => {
          throw new FakeSlackError('message_not_found')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-found')
  })

  it('maps cant_update_message (not the author) to permission-denied', async () => {
    const cb = createSlackEditMessageCallback({
      client: {
        updateMessage: async () => {
          throw new FakeSlackError('cant_update_message')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('permission-denied')
  })

  it('appends the scope hint on missing_scope', async () => {
    const cb = createSlackEditMessageCallback({
      client: {
        updateMessage: async () => {
          throw new FakeSlackError('missing_scope')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('permission-denied')
      expect(result.error).toContain('chat:write')
    }
  })
})
