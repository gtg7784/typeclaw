import { describe, expect, it } from 'bun:test'

import type { EditMessageRequest } from '@/channels/types'

import { createTelegramEditMessageCallback } from './telegram-bot-edit'
import { toTelegramMarkdownV2 } from './telegram-bot-format'

const req = (over: Partial<EditMessageRequest> = {}): EditMessageRequest => ({
  adapter: 'telegram-bot',
  workspace: 'telegram',
  chat: '12345',
  thread: null,
  messageId: '678',
  text: 'edited body',
  ...over,
})

describe('createTelegramEditMessageCallback', () => {
  it('renders MarkdownV2 and passes the parse_mode option, mirroring the send path', async () => {
    const calls: Array<{ target: unknown; text: string; options: unknown }> = []
    const cb = createTelegramEditMessageCallback({
      client: {
        editMessageText: async (target, text, options) => {
          calls.push({ target, text, options })
          return true
        },
      },
    })

    // given a body with a MarkdownV2 reserved char the send path would escape
    const result = await cb(req({ text: 'edited body (v2)' }))

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([
      {
        target: { chat_id: '12345', message_id: 678 },
        text: toTelegramMarkdownV2('edited body (v2)'),
        options: { parse_mode: 'MarkdownV2' },
      },
    ])
    // and the rendered text is actually escaped, not raw
    expect(calls[0]?.text).not.toBe('edited body (v2)')
  })

  it('treats a non-numeric message id as a not-found miss without calling the SDK', async () => {
    let called = false
    const cb = createTelegramEditMessageCallback({
      client: {
        editMessageText: async () => {
          called = true
          return true
        },
      },
    })

    const result = await cb(req({ messageId: 'not-a-number' }))

    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-found')
  })

  it('treats "message is not modified" as an idempotent success', async () => {
    const cb = createTelegramEditMessageCallback({
      client: {
        editMessageText: async () => {
          throw new Error('Bad Request: message is not modified')
        },
      },
    })

    const result = await cb(req())

    expect(result).toEqual({ ok: true })
  })

  it('maps a rights error to permission-denied', async () => {
    const cb = createTelegramEditMessageCallback({
      client: {
        editMessageText: async () => {
          throw new Error('Bad Request: not enough rights to edit a message')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('permission-denied')
  })
})
