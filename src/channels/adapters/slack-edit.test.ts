import { describe, expect, it } from 'bun:test'

import type { EditMessageRequest } from '@/channels/types'

import { createSlackUserEditMessageCallback } from './slack-edit'

class FakeSlackError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

const req = (over: Partial<EditMessageRequest> = {}): EditMessageRequest => ({
  adapter: 'slack',
  workspace: 'T1',
  chat: 'C1',
  thread: null,
  messageId: '1700000000.000100',
  text: 'edited body',
  ...over,
})

describe('createSlackUserEditMessageCallback', () => {
  it('calls updateMessage with (channel, ts, text) and returns ok', async () => {
    const calls: Array<{ channel: string; ts: string; text: string }> = []
    const cb = createSlackUserEditMessageCallback({
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
    const cb = createSlackUserEditMessageCallback({
      client: { updateMessage: async () => ({ ts: 'x', text: 'x', type: 'message' }) },
    })

    const result = await cb(req({ adapter: 'slack-bot' }))

    expect(result).toEqual({ ok: false, error: 'unknown adapter: slack-bot', code: 'not-supported' })
  })

  it('maps cant_update_message to permission-denied', async () => {
    const cb = createSlackUserEditMessageCallback({
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
})
