import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { AgentSession } from '@/agent'

import { createChannelRouter, type ChannelRouter } from './router'
import type { ChannelAdapterConfig } from './schema'
import { loadChannelSessions } from './persistence'
import type { ChannelKey, InboundMessage } from './types'

class FakeSession {
  public prompts: string[] = []
  public aborted = 0
  public disposed = 0

  prompt = async (text: string): Promise<void> => {
    this.prompts.push(text)
  }
  abort = async (): Promise<void> => {
    this.aborted++
  }
  dispose = (): void => {
    this.disposed++
  }
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'channels-router-'))
}

const baseConfig: ChannelAdapterConfig = {
  allow: ['*'],
  engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
  enabled: true,
}

function makeRouter(
  agentDir: string,
  options: {
    config?: ChannelAdapterConfig
    sessions?: FakeSession[]
    nowRef?: { value: number }
  } = {},
): { router: ChannelRouter; sessions: FakeSession[] } {
  const sessions: FakeSession[] = options.sessions ?? []
  const nowRef = options.nowRef ?? { value: 1000 }
  const router = createChannelRouter({
    agentDir,
    configForAdapter: () => options.config ?? baseConfig,
    now: () => nowRef.value,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    createSessionForChannel: async () => {
      const fake = new FakeSession()
      sessions.push(fake)
      return {
        session: fake as unknown as AgentSession,
        sessionId: `ses_fake_${sessions.length}`,
        dispose: async () => {
          fake.dispose()
        },
      }
    },
  })
  return { router, sessions }
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: 'discord-bot',
    workspace: 'g1',
    chat: 'c1',
    thread: null,
    text: 'hello',
    externalMessageId: 'm1',
    authorId: 'alice',
    authorName: 'alice',
    isBotMention: true,
    replyToBotMessageId: null,
    isDm: false,
    ...over,
  }
}

const KEY: ChannelKey = { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null }

describe('ChannelRouter session lifecycle', () => {
  test('creates a session on first inbound and reuses it on second', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ externalMessageId: 'm2', text: 'follow up' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(1)
    expect(router.liveCount()).toBe(1)
  })

  test('persists the (4-tuple → sessionId) mapping to channels/sessions.json', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    await router.route(inbound())
    await new Promise((r) => setTimeout(r, 10))
    const loaded = await loadChannelSessions(dir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.adapter).toBe('discord-bot')
    expect(loaded[0]?.workspace).toBe('g1')
    expect(loaded[0]?.chat).toBe('c1')
    expect(loaded[0]?.thread).toBeNull()
    expect(loaded[0]?.sessionId).toBe('ses_fake_1')
  })

  test('separate (workspace, chat) tuples get separate sessions', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ workspace: 'g1', chat: 'c1' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    await router.route(inbound({ workspace: 'g1', chat: 'c2' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c2', thread: null })
    expect(sessions).toHaveLength(2)
    expect(router.liveCount()).toBe(2)
  })

  test('concurrent inbounds for a cold tuple share one session creation', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await Promise.all([router.route(inbound()), router.route(inbound({ externalMessageId: 'm2' }))])
    expect(sessions).toHaveLength(1)
  })
})

describe('ChannelRouter engagement and prompt composition', () => {
  test('engaging inbound is delivered to session.prompt with attribution', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'what time is it?' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('<@alice> (alice): what time is it?')
  })

  test('non-engaging inbound goes to context buffer, not session.prompt', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ isBotMention: false, text: 'unrelated chatter' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('coalesces a multi-message burst into one prompt', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'hi' }))
    await router.route(inbound({ externalMessageId: 'm2', text: 'how' }))
    await router.route(inbound({ externalMessageId: 'm3', text: 'are you' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('hi')
    expect(sessions[0]!.prompts[0]).toContain('how')
    expect(sessions[0]!.prompts[0]).toContain('are you')
  })

  test('drains observed messages as "Recent context" before engaged messages', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ isBotMention: false, authorId: 'bob', authorName: 'bob', text: 'unrelated' }))
    await router.route(inbound({ text: 'hey bot' }))
    await router.__testing!.flushDebounce(KEY)
    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('Recent context (not addressed to you, for awareness only)')
    expect(prompt).toContain('<@bob> (bob): unrelated')
    expect(prompt).toContain('Current message')
    expect(prompt).toContain('<@alice> (alice): hey bot')
    expect(prompt.indexOf('unrelated')).toBeLessThan(prompt.indexOf('hey bot'))
  })

  test('empty allow rules + observed-only burst produces no prompt and no crash', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, {
      config: {
        allow: [],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
      },
    })
    await router.route(inbound({ isBotMention: false }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(0)
  })
})

describe('ChannelRouter sticky credits', () => {
  test('agent-sent reply grants sticky to the inbound author for the next message', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })

    await router.route(inbound({ text: 'first' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)

    nowRef.value = 1500
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hi alice',
    })
    expect(result.ok).toBe(true)

    nowRef.value = 2000
    await router.route(inbound({ externalMessageId: 'm2', isBotMention: false, text: 'thanks' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(sessions[0]!.prompts[1]).toContain('thanks')
  })
})

describe('ChannelRouter outbound', () => {
  test('returns ok:false when no adapter callback is registered', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hi',
    })
    expect(result.ok).toBe(false)
  })

  test('forwards to the registered adapter callback', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const captured: { chat: string; text: string } = { chat: '', text: '' }
    router.registerOutbound('discord-bot', async (msg) => {
      captured.chat = msg.chat
      captured.text = msg.text
      return { ok: true }
    })
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c-99',
      text: 'announcement',
    })
    expect(result.ok).toBe(true)
    expect(captured).toEqual({ chat: 'c-99', text: 'announcement' })
  })

  test('returns ok:false with adapter error when callback denies', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: false, error: 'denied by allow rules' }))
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'nope',
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error : '').toContain('denied')
  })
})

describe('ChannelRouter stop', () => {
  test('aborts in-flight session and disposes', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    await router.stop()
    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.disposed).toBe(1)
    expect(router.liveCount()).toBe(0)
  })
})
