import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { isAllowed } from '@/channels/schema'

import { createTypingCallback, DISCORD_BOT_INTENTS } from './discord-bot'
import { DiscordIntent } from './agent-messenger-shim'

describe('discord-bot adapter (unit-level pure helpers)', () => {
  test('isAllowed denies a guild channel not in the allow list', () => {
    expect(isAllowed(['guild:1/2'], '1', '99')).toBe(false)
    expect(isAllowed(['guild:1/2'], '2', '2')).toBe(false)
  })

  test('isAllowed admits a guild channel in the allow list', () => {
    expect(isAllowed(['guild:1/2'], '1', '2')).toBe(true)
  })

  test('isAllowed admits DMs only when the rule covers @dm', () => {
    expect(isAllowed(['guild:*'], '@dm', 'd1')).toBe(false)
    expect(isAllowed(['dm:*'], '@dm', 'd1')).toBe(true)
    expect(isAllowed(['*'], '@dm', 'd1')).toBe(true)
  })
})

describe('discord-bot gateway intents', () => {
  test('includes MessageContent (privileged) so inbound messages carry text', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.MessageContent).toBe(DiscordIntent.MessageContent)
  })

  test('includes DirectMessages so DMs are delivered to the gateway', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.DirectMessages).toBe(DiscordIntent.DirectMessages)
  })

  test('includes GuildMessages so guild channel messages are delivered', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.GuildMessages).toBe(DiscordIntent.GuildMessages)
  })
})

describe('createTypingCallback', () => {
  let originalFetch: typeof fetch
  let calls: Array<{ url: string; init: RequestInit }>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('POSTs to /channels/{chat}/typing with bot token authorization', async () => {
    const cb = createTypingCallback({
      token: 'tok-abc',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/c1/typing')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot tok-abc')
  })

  test('uses thread id as the channel id when thread is set', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 'thr-9' })
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/thr-9/typing')
  })

  test('skips disallowed channels (does not call fetch)', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['guild:other'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(calls).toHaveLength(0)
  })

  test('non-OK responses are logged but do not throw', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 429 })) as unknown as typeof fetch
    const warns: string[] = []
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(warns.some((m) => m.includes('429'))).toBe(true)
  })

  test('fetch rejection is swallowed and logged', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const warns: string[] = []
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(warns.some((m) => m.includes('network down'))).toBe(true)
  })

  test('rejects unknown adapter without calling fetch', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      configRef: () => ({ allow: ['*'], engagement: { trigger: ['mention'], stickiness: 'off' }, enabled: true }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // @ts-expect-error testing the runtime guard
    await cb({ adapter: 'slack-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(calls).toHaveLength(0)
  })
})
