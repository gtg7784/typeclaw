import { describe, expect, it } from 'bun:test'

import type { EditMessageRequest } from '@/channels/types'

import { createWebexEditMessageCallback } from './webex-edit'

class FakeHttpError extends Error {
  constructor(public status: number) {
    super(`http ${status}`)
  }
}

const req = (over: Partial<EditMessageRequest> = {}): EditMessageRequest => ({
  adapter: 'webex',
  workspace: 'room-1',
  chat: 'room-1',
  thread: null,
  messageId: 'msg-1',
  text: 'edited body',
  ...over,
})

describe('createWebexEditMessageCallback', () => {
  it('calls editMessage with (messageId, roomId=chat, text) and returns ok', async () => {
    const calls: Array<{ messageId: string; roomId: string; text: string }> = []
    const cb = createWebexEditMessageCallback({
      adapter: 'webex',
      client: {
        editMessage: async (messageId, roomId, text) => {
          calls.push({ messageId, roomId, text })
          return {}
        },
      },
    })

    const result = await cb(req())

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ messageId: 'msg-1', roomId: 'room-1', text: 'edited body' }])
  })

  it('guards against the wrong adapter id', async () => {
    const cb = createWebexEditMessageCallback({
      adapter: 'webex-bot',
      client: { editMessage: async () => ({}) },
    })

    const result = await cb(req({ adapter: 'webex' }))

    expect(result).toEqual({ ok: false, error: 'unknown adapter: webex', code: 'not-supported' })
  })

  it('maps a 403 to permission-denied and a 404 to not-found', async () => {
    const forbidden = createWebexEditMessageCallback({
      adapter: 'webex',
      client: {
        editMessage: async () => {
          throw new FakeHttpError(403)
        },
      },
    })
    const missing = createWebexEditMessageCallback({
      adapter: 'webex',
      client: {
        editMessage: async () => {
          throw new FakeHttpError(404)
        },
      },
    })

    const forbiddenResult = await forbidden(req())
    const missingResult = await missing(req())

    expect(forbiddenResult.ok).toBe(false)
    if (!forbiddenResult.ok) expect(forbiddenResult.code).toBe('permission-denied')
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) expect(missingResult.code).toBe('not-found')
  })
})
