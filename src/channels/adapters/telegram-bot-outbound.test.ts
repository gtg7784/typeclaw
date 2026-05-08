import { describe, expect, test } from 'bun:test'

import type { TelegramBotClient, TelegramMessage } from 'agent-messenger/telegrambot'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { OutboundMessage } from '@/channels/types'

import { createOutboundCallback, createTypingCallback, type TelegramBotAdapterLogger } from './telegram-bot'

function silentLogger(): TelegramBotAdapterLogger & { warns: string[]; errors: string[]; infos: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  return {
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    warns,
    errors,
    infos,
  }
}

function fakeFetch(responder: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(responder(typeof url === 'string' ? url : url.toString(), init))) as typeof fetch
}

const baseConfig: ChannelAdapterConfig = {
  allow: ['*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
}

function fakeMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: -100123, type: 'supergroup', title: 'Eng' },
    ...overrides,
  }
}

type SendMessageCall = { chatId: string | number; text: string; options: unknown }
type SendDocumentCall = { chatId: string | number; filePath: string }

function fakeClient(): {
  client: Pick<TelegramBotClient, 'sendMessage' | 'sendDocument'>
  sendMessageCalls: SendMessageCall[]
  sendDocumentCalls: SendDocumentCall[]
  setSendMessageBehavior: (fn: () => Promise<TelegramMessage>) => void
  setSendDocumentBehavior: (fn: () => Promise<TelegramMessage>) => void
} {
  const sendMessageCalls: SendMessageCall[] = []
  const sendDocumentCalls: SendDocumentCall[] = []
  let sendMessageImpl: () => Promise<TelegramMessage> = async () => fakeMessage({ message_id: 100 })
  let sendDocumentImpl: () => Promise<TelegramMessage> = async () => fakeMessage({ message_id: 200 })
  const client = {
    sendMessage: async (chatId: string | number, text: string, options?: unknown) => {
      sendMessageCalls.push({ chatId, text, options })
      return sendMessageImpl()
    },
    sendDocument: async (chatId: string | number, filePath: string) => {
      sendDocumentCalls.push({ chatId, filePath })
      return sendDocumentImpl()
    },
  } as unknown as Pick<TelegramBotClient, 'sendMessage' | 'sendDocument'>
  return {
    client,
    sendMessageCalls,
    sendDocumentCalls,
    setSendMessageBehavior: (fn) => {
      sendMessageImpl = fn
    },
    setSendDocumentBehavior: (fn) => {
      sendDocumentImpl = fn
    },
  }
}

function buildOutbound(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    adapter: 'telegram-bot',
    workspace: 'telegram',
    chat: '-100123',
    text: 'hello world',
    ...over,
  }
}

describe('telegram-bot createOutboundCallback', () => {
  test('sends plain text by default with NO parse_mode (HTML/MarkdownV2 reject too many strings)', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => baseConfig,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ text: 'a < b & c > d (with) raw . ! _ * special chars' }))

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls).toHaveLength(1)
    expect(fake.sendMessageCalls[0]?.text).toBe('a < b & c > d (with) raw . ! _ * special chars')
    // Mutation guard: if a refactor re-introduces parse_mode: 'HTML' as a
    // default, this assertion fails. The whole point of the v2 fix was
    // that raw `<` / `&` would crash Telegram's HTML parser.
    expect(fake.sendMessageCalls[0]?.options).toEqual({})
  })

  test('forwards a numeric thread id as message_thread_id when the session is in a forum topic', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => baseConfig,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ thread: '42' }))

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls[0]?.options).toEqual({ message_thread_id: 42 })
  })

  test('drops invalid thread ids silently rather than passing NaN', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => baseConfig,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ thread: 'not-a-number' }))

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls[0]?.options).toEqual({})
  })

  test('uploads each attachment via sendDocument BEFORE posting text', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => baseConfig,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(
      buildOutbound({
        text: 'see file',
        attachments: [{ path: '/agent/workspace/spec.pdf' }],
      }),
    )

    expect(result.ok).toBe(true)
    expect(fake.sendDocumentCalls).toEqual([{ chatId: '-100123', filePath: '/agent/workspace/spec.pdf' }])
    expect(fake.sendMessageCalls).toHaveLength(1)
    expect(fake.sendMessageCalls[0]?.text).toBe('see file')
  })

  test('warns when an attachment is sent in a forum topic (sendDocument cannot route to topic)', async () => {
    const fake = fakeClient()
    const logger = silentLogger()
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => baseConfig,
      logger,
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(
      buildOutbound({
        thread: '42',
        attachments: [{ path: '/agent/workspace/file.txt' }],
      }),
    )

    expect(result.ok).toBe(true)
    expect(logger.warns.some((m) => m.includes('landed in chat root, not topic 42'))).toBe(true)
  })

  test('does NOT warn about topic routing for attachments when the session is not in a topic', async () => {
    const fake = fakeClient()
    const logger = silentLogger()
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => baseConfig,
      logger,
      formatChannelTag: async () => 'chat=-100123',
    })

    await cb(buildOutbound({ attachments: [{ path: '/x' }] }))

    expect(logger.warns.filter((m) => m.includes('landed in chat root'))).toHaveLength(0)
  })

  test('aborts before posting text when an upload fails (file is the load-bearing piece)', async () => {
    const fake = fakeClient()
    fake.setSendDocumentBehavior(async () => {
      throw new Error('upload failed: 413 too large')
    })
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => baseConfig,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(
      buildOutbound({
        text: 'context',
        attachments: [{ path: '/x' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('sendDocument failed')
    expect(fake.sendMessageCalls).toHaveLength(0)
  })

  test('refuses outbound when allow rules deny the chat (defense-in-depth, in case the agent constructs an outbound on its own)', async () => {
    const fake = fakeClient()
    const restrictiveConfig: ChannelAdapterConfig = { ...baseConfig, allow: ['tg:-999'] }
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => restrictiveConfig,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('denied by allow rules')
    expect(fake.sendMessageCalls).toHaveLength(0)
    expect(fake.sendDocumentCalls).toHaveLength(0)
  })

  test('refuses outbound with neither text nor attachments', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      configRef: () => baseConfig,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ text: '' }))

    expect(result.ok).toBe(false)
    expect(fake.sendMessageCalls).toHaveLength(0)
  })
})

describe('telegram-bot createTypingCallback', () => {
  test('POSTs sendChatAction with the chat_id and action=typing', async () => {
    const seen: Array<{ url: string; body: string }> = []
    const cb = createTypingCallback({
      token: 'TGTOKEN',
      configRef: () => baseConfig,
      logger: silentLogger(),
      fetchImpl: fakeFetch((url, init) => {
        seen.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: null, phase: 'tick' })

    expect(seen[0]?.url).toBe('https://api.telegram.org/botTGTOKEN/sendChatAction')
    const body = JSON.parse(seen[0]!.body) as { chat_id: string; action: string; message_thread_id?: number }
    expect(body.chat_id).toBe('-100123')
    expect(body.action).toBe('typing')
    expect(body.message_thread_id).toBeUndefined()
  })

  test('forwards a valid numeric thread id as message_thread_id', async () => {
    const seen: Array<{ body: string }> = []
    const cb = createTypingCallback({
      token: 'T',
      configRef: () => baseConfig,
      logger: silentLogger(),
      fetchImpl: fakeFetch((_url, init) => {
        seen.push({ body: typeof init?.body === 'string' ? init.body : '' })
        return new Response('{}', { status: 200 })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: '7', phase: 'tick' })

    const body = JSON.parse(seen[0]!.body) as { message_thread_id?: number }
    expect(body.message_thread_id).toBe(7)
  })

  test('omits message_thread_id when the thread string is non-numeric (no NaN payload)', async () => {
    const seen: Array<{ body: string }> = []
    const cb = createTypingCallback({
      token: 'T',
      configRef: () => baseConfig,
      logger: silentLogger(),
      fetchImpl: fakeFetch((_url, init) => {
        seen.push({ body: typeof init?.body === 'string' ? init.body : '' })
        return new Response('{}', { status: 200 })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: 'oops', phase: 'tick' })

    const body = JSON.parse(seen[0]!.body) as { message_thread_id?: number; chat_id: string }
    expect(body.message_thread_id).toBeUndefined()
    expect(body.chat_id).toBe('-100123')
  })

  test('no-ops on phase=stop (Telegram has no explicit clear; auto-expires after ~5s)', async () => {
    let fetchCalled = false
    const cb = createTypingCallback({
      token: 'T',
      configRef: () => baseConfig,
      logger: silentLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('{}', { status: 200 })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: null, phase: 'stop' })

    expect(fetchCalled).toBe(false)
  })

  test('no-ops when allow rules deny the chat', async () => {
    let fetchCalled = false
    const restrictiveConfig: ChannelAdapterConfig = { ...baseConfig, allow: ['tg:-999'] }
    const cb = createTypingCallback({
      token: 'T',
      configRef: () => restrictiveConfig,
      logger: silentLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('{}', { status: 200 })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: null, phase: 'tick' })

    expect(fetchCalled).toBe(false)
  })
})
