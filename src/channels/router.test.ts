import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile as writeFileFs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { AssistantMessage } from '@mariozechner/pi-ai'
import type { SessionEntry } from '@mariozechner/pi-coding-agent'

import type { AgentSession } from '@/agent'
import type { SessionOrigin } from '@/agent/session-origin'
import type { HookBus, SessionIdleEvent } from '@/plugin'

import { channelsSessionsPath, loadChannelSessions, saveChannelSessions } from './persistence'
import { createChannelRouter, SESSION_IDLE_MS, sliceHeadTail, type ChannelRouter } from './router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from './schema'
import type { ChannelHistoryMessage, ChannelKey, FetchHistoryArgs, HistoryCallback, InboundMessage } from './types'

class FakeSession {
  public prompts: string[] = []
  public aborted = 0
  public disposed = 0
  public leafEntry: SessionEntry | undefined
  public onPrompt: ((text: string) => void | Promise<void>) | undefined

  public sessionManager = {
    getLeafEntry: (): SessionEntry | undefined => this.leafEntry,
  }

  prompt = async (text: string): Promise<void> => {
    this.prompts.push(text)
    await this.onPrompt?.(text)
  }
  abort = async (): Promise<void> => {
    this.aborted++
  }
  dispose = (): void => {
    this.disposed++
  }

  setAssistantText(text: string): void {
    this.leafEntry = messageEntry(assistantMessage(text))
  }
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'channels-router-'))
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1000,
  }
}

function messageEntry(message: AssistantMessage): SessionEntry {
  return {
    type: 'message',
    id: 'assistant-entry',
    parentId: null,
    timestamp: '2026-05-01T00:00:00.000Z',
    message,
  }
}

const baseConfig: ChannelAdapterConfig = {
  allow: ['*'],
  engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
  enabled: true,
  history: defaultHistoryConfig(),
}

type SessionFactoryArgs = {
  existingSessionId?: string
  existingSessionFile?: string
}

function makeRouter(
  agentDir: string,
  options: {
    config?: ChannelAdapterConfig
    sessions?: FakeSession[]
    nowRef?: { value: number }
    logs?: string[]
    origins?: SessionOrigin[]
    factoryCalls?: SessionFactoryArgs[]
    transcriptPathFor?: (sessionId: string) => string | undefined
    configuredAliases?: () => readonly string[]
  } = {},
): { router: ChannelRouter; sessions: FakeSession[]; origins: SessionOrigin[] } {
  const sessions: FakeSession[] = options.sessions ?? []
  const origins: SessionOrigin[] = options.origins ?? []
  const nowRef = options.nowRef ?? { value: 1000 }
  const router = createChannelRouter({
    agentDir,
    configForAdapter: () => options.config ?? baseConfig,
    ...(options.configuredAliases !== undefined ? { configuredAliases: options.configuredAliases } : {}),
    now: () => nowRef.value,
    logger: {
      info: (m) => options.logs?.push(`info:${m}`),
      warn: (m) => options.logs?.push(`warn:${m}`),
      error: (m) => options.logs?.push(`error:${m}`),
    },
    createSessionForChannel: async ({ origin, existingSessionId, existingSessionFile }) => {
      options.factoryCalls?.push({
        ...(existingSessionId !== undefined ? { existingSessionId } : {}),
        ...(existingSessionFile !== undefined ? { existingSessionFile } : {}),
      })
      origins.push(origin)
      const fake = new FakeSession()
      sessions.push(fake)
      const sessionId = existingSessionId ?? `ses_fake_${sessions.length}`
      return {
        session: fake as unknown as AgentSession,
        sessionId,
        dispose: async () => {
          fake.dispose()
        },
        ...(options.transcriptPathFor !== undefined
          ? { getTranscriptPath: () => options.transcriptPathFor!(sessionId) }
          : {}),
      }
    },
  })
  return { router, sessions, origins }
}

const FIXED_INBOUND_TS = Date.parse('2024-06-15T12:34:56.000Z')
const FIXED_INBOUND_ISO = '2024-06-15T12:34:56.000Z'

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
    authorIsBot: false,
    isBotMention: true,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts: FIXED_INBOUND_TS,
    ...over,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition not met')
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

  test('persists sessionFile from getTranscriptPath() so reopen across restart can find the file', async () => {
    // given: a factory whose session manager exposes a transcript path with a
    // pi-coding-agent-style ${ISO_TIMESTAMP}_${sessionId}.jsonl basename
    const dir = await tempDir()
    const transcriptDir = '/tmp/fake-sessions'
    const transcriptPathFor = (sessionId: string): string =>
      `${transcriptDir}/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`
    const { router } = makeRouter(dir, { transcriptPathFor })

    // when: a brand-new channel session is created
    await router.route(inbound())
    await new Promise((r) => setTimeout(r, 10))

    // then: the persisted record carries the basename, NOT the full path
    const loaded = await loadChannelSessions(dir)
    expect(loaded[0]?.sessionFile).toBe('2026-05-02T16-56-52-380Z_ses_fake_1.jsonl')
  })

  test('after restart, a second router instance passes the persisted sessionFile to the factory', async () => {
    // given: a first router run that produces a persisted mapping with sessionFile
    const dir = await tempDir()
    const transcriptPathFor = (sessionId: string): string =>
      `/tmp/fake-sessions/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`
    const firstRun = makeRouter(dir, { transcriptPathFor })
    await firstRun.router.route(inbound({ text: '재시작해줘' }))
    await firstRun.router.__testing!.flushDebounce(KEY)
    await firstRun.router.stop()

    // when: a fresh router instance (simulating container restart) handles a new inbound
    // for the same channel
    const factoryCalls: SessionFactoryArgs[] = []
    const secondRun = makeRouter(dir, { transcriptPathFor, factoryCalls })
    await secondRun.router.route(inbound({ text: '다시 해봐', externalMessageId: 'm-followup' }))
    await secondRun.router.__testing!.flushDebounce(KEY)

    // then: the factory was called with BOTH existingSessionId AND existingSessionFile
    // (regression: previously only existingSessionId was passed, and the consumer
    // constructed `${sessionDir}/${sessionId}.jsonl` which never matched the on-disk
    // ${ISO}_${sessionId}.jsonl, silently creating a fresh session every restart)
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_fake_1')
    expect(factoryCalls[0]?.existingSessionFile).toBe('2026-05-02T16-56-52-380Z_ses_fake_1.jsonl')
  })

  test('restart with a v2 mapping (no sessionFile, file actually present) migrates and reopens', async () => {
    // given: a v2 mapping on disk plus the matching pi-coding-agent file
    const dir = await tempDir()
    const sessionsDir = join(dir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFileFs(
      join(sessionsDir, '2026-05-02T16-56-52-380Z_ses_legacy.jsonl'),
      '{"type":"session","version":3,"id":"ses_legacy","timestamp":"2026-05-02T16:56:52.380Z","cwd":"/agent"}\n',
    )
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFileFs(
      channelsSessionsPath(dir),
      JSON.stringify({
        version: 2,
        sessions: [
          {
            adapter: 'discord-bot',
            workspace: 'g1',
            chat: 'c1',
            thread: null,
            sessionId: 'ses_legacy',
            participants: [],
          },
        ],
      }),
    )

    const factoryCalls: SessionFactoryArgs[] = []
    const transcriptPathFor = (sessionId: string): string =>
      `${sessionsDir}/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`
    const { router } = makeRouter(dir, { factoryCalls, transcriptPathFor })

    // when: a new inbound arrives after the v2→v3 migration
    await router.route(inbound({ text: 'hi' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the migrated sessionFile was passed to the factory
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_legacy')
    expect(factoryCalls[0]?.existingSessionFile).toBe('2026-05-02T16-56-52-380Z_ses_legacy.jsonl')
  })

  test('restart with a v2 mapping whose session file is missing creates a fresh session', async () => {
    // given: a v2 mapping pointing at a session id with no on-disk file
    const dir = await tempDir()
    await mkdir(join(dir, 'sessions'), { recursive: true })
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFileFs(
      channelsSessionsPath(dir),
      JSON.stringify({
        version: 2,
        sessions: [
          {
            adapter: 'discord-bot',
            workspace: 'g1',
            chat: 'c1',
            thread: null,
            sessionId: 'ses_lost',
            participants: [],
          },
        ],
      }),
    )

    const factoryCalls: SessionFactoryArgs[] = []
    const { router } = makeRouter(dir, { factoryCalls })

    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    // existingSessionId still propagates, but existingSessionFile is undefined,
    // signaling the consumer to create a fresh SessionManager
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_lost')
    expect(factoryCalls[0]?.existingSessionFile).toBeUndefined()
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

  test('prompt line is prefixed with the platform-side ISO 8601 timestamp from event.ts', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'hello there', ts: FIXED_INBOUND_TS }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts[0]).toContain(`[${FIXED_INBOUND_ISO}] <@alice> (alice): hello there`)
  })

  test('prompt line omits the timestamp prefix when ts is unknown (0)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'hello there', ts: 0 }))
    await router.__testing!.flushDebounce(KEY)
    const line = sessions[0]!.prompts[0]!
    expect(line).toContain('<@alice> (alice): hello there')
    expect(line).not.toMatch(/\[\d{4}-\d{2}-\d{2}T/)
  })

  test('non-engaging inbound goes to context buffer, not session.prompt', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    // Prime participants with a second human so we exercise the strict gate
    // rather than the solo-human fallback (which would engage on any message).
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol', text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0
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
    // Prime participants with carol so bob's later non-mention message
    // doesn't trigger the solo-human fallback. We need bob's message to
    // observe so we can verify the Recent context prefix.
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol', text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0
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
        history: defaultHistoryConfig(),
      },
    })
    // Prime participants with carol so the next non-mention message hits the
    // strict gate (which observes) rather than the solo-human fallback.
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0
    await router.route(inbound({ isBotMention: false }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('solo-human channel: plain message engages without mention/reply/dm', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ isBotMention: false, text: 'hello there' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('<@alice> (alice): hello there')
  })

  test('solo-human fallback turns off once a second human posts', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    // Alice (solo) → engages on plain message.
    await router.route(inbound({ isBotMention: false, text: 'first' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    // Bob arrives mentioning the bot → engages via strict gate.
    await router.route(inbound({ authorId: 'bob', authorName: 'bob', isBotMention: true, text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(2)
    // Alice's next plain message must now observe (2 humans in cache).
    await router.route(inbound({ isBotMention: false, text: 'follow up' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(2)
  })

  test('registered membership resolver gates first cold inbound before sticky can start', async () => {
    const dir = await tempDir()
    const { router, sessions, origins } = makeRouter(dir)
    router.registerMembership('discord-bot', async () => ({
      humans: 5,
      bots: 2,
      fetchedAt: Date.now(),
      truncated: false,
    }))

    await router.route(inbound({ isBotMention: false, text: 'ambient hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(0)
    expect(origins[0]).toMatchObject({ kind: 'channel', membership: { humans: 5, bots: 2, truncated: false } })
  })

  test('membership resolver failure preserves legacy null fallback', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerMembership('discord-bot', async () => ({ kind: 'transient' }))

    await router.route(inbound({ isBotMention: false, text: 'solo hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('solo hello')
  })

  test('large approximate membership counts still quiet plain chatter', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerMembership('discord-bot', async () => ({
      humans: 30,
      bots: 5,
      fetchedAt: Date.now(),
      truncated: true,
    }))

    await router.route(inbound({ isBotMention: false, text: 'ambient hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('previously-unseen author triggers a membership refetch (warmup after invalidate)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let resolverCalls = 0
    router.registerMembership('discord-bot', async () => {
      resolverCalls++
      return { humans: 1, bots: 0, fetchedAt: Date.now(), truncated: false }
    })

    await router.route(inbound({ authorId: 'alice', authorName: 'alice' }))
    await router.__testing!.flushDebounce(KEY)
    const callsAfterFirstAuthor = resolverCalls

    // Same author — no invalidation, no extra resolver call (cache still hot)
    await router.route(inbound({ authorId: 'alice', authorName: 'alice', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(resolverCalls).toBe(callsAfterFirstAuthor)

    // Novel author — cache invalidated, warmup kicks off (additional resolver hit)
    await router.route(inbound({ authorId: 'bob', authorName: 'bob', externalMessageId: 'm3' }))
    await router.__testing!.flushDebounce(KEY)
    await waitFor(() => resolverCalls > callsAfterFirstAuthor)
    expect(resolverCalls).toBeGreaterThan(callsAfterFirstAuthor)
  })

  test('DM channels skip the new-author invalidation path', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let resolverCalls = 0
    router.registerMembership('discord-bot', async () => {
      resolverCalls++
      return { humans: 1, bots: 1, fetchedAt: Date.now(), truncated: false }
    })

    const dmKey: ChannelKey = { adapter: 'discord-bot', workspace: '@dm', chat: 'd1', thread: null }
    await router.route(inbound({ workspace: '@dm', chat: 'd1', isDm: true, authorId: 'alice', authorName: 'alice' }))
    await router.__testing!.flushDebounce(dmKey)
    const callsAfterFirst = resolverCalls

    await router.route(
      inbound({
        workspace: '@dm',
        chat: 'd1',
        isDm: true,
        authorId: 'bob',
        authorName: 'bob',
        externalMessageId: 'm2',
      }),
    )
    await router.__testing!.flushDebounce(dmKey)

    expect(resolverCalls).toBe(callsAfterFirst)
  })
})

describe('ChannelRouter alias engagement', () => {
  test('engages on dir-name implicit alias even with no configured aliases', async () => {
    const dir = await tempDir()
    const dirName = basename(dir)
    const { router, sessions } = makeRouter(dir, {
      config: { ...baseConfig, engagement: { trigger: [], stickiness: 'off' } },
    })

    await router.route(
      inbound({
        text: `Hey ${dirName.toUpperCase()}, cron 좀 봐줘`,
        isBotMention: false,
        authorId: 'devxoul',
        authorName: 'devxoul',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    await router.route(
      inbound({
        externalMessageId: 'm2',
        text: `Hey ${dirName}, cron 좀 봐줘`,
        isBotMention: false,
        authorId: 'second-human',
        authorName: 'second-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
  })

  test('engages on configured alias substring', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, {
      config: { ...baseConfig, engagement: { trigger: [], stickiness: 'off' } },
      configuredAliases: () => ['봉봉', 'bongbong'],
    })

    await router.route(
      inbound({
        text: '봉봉아 cron 좀 봐줘',
        isBotMention: false,
        authorId: 'devxoul',
        authorName: 'devxoul',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    await router.route(
      inbound({
        externalMessageId: 'm2',
        text: '봉봉아 cron 좀 봐줘',
        isBotMention: false,
        authorId: 'second-human',
        authorName: 'second-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
  })

  test('reads aliases live each inbound (live-reload contract)', async () => {
    const dir = await tempDir()
    let aliases: readonly string[] = []
    const { router, sessions } = makeRouter(dir, {
      config: { ...baseConfig, engagement: { trigger: [], stickiness: 'off' } },
      configuredAliases: () => aliases,
    })

    await router.route(
      inbound({
        text: '봉봉아 cron',
        isBotMention: false,
        authorId: 'devxoul',
        authorName: 'devxoul',
      }),
    )
    await router.route(
      inbound({
        externalMessageId: 'm2',
        text: 'second human posts',
        isBotMention: false,
        authorId: 'second-human',
        authorName: 'second-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    aliases = ['봉봉']
    await router.route(
      inbound({
        externalMessageId: 'm3',
        text: '봉봉아 cron',
        isBotMention: false,
        authorId: 'devxoul',
        authorName: 'devxoul',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts.some((p) => p.includes('봉봉아 cron'))).toBe(true)
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
      captured.text = msg.text ?? ''
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

describe('ChannelRouter channel-turn protocol', () => {
  test('allows NO_REPLY when no channel tool sent a message', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })

    await router.route(inbound({ text: 'just FYI' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('blocked assistant_text_without_channel_tool'))).toBe(false)
  })

  test('recovers visible assistant text when no channel tool sent a message', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    const sent: Array<{ chat: string; thread: string | null | undefined; text: string }> = []
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ chat: msg.chat, thread: msg.thread, text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'say hi' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('hi from invisible assistant text')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toEqual([{ chat: 'c1', thread: null, text: 'hi from invisible assistant text' }])
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
    expect(logs.some((m) => m.includes('blocked assistant_text_without_channel_tool'))).toBe(false)
  })

  test('logs recovery send failures without crashing the drain loop', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async () => ({ ok: false, error: 'denied by adapter' }))

    await router.route(inbound({ text: 'say hi' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('hi from invisible assistant text')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('recovery send failed: denied by adapter'))).toBe(true)
    expect(logs.some((m) => m.includes('prompt threw'))).toBe(false)
  })

  test('does not block visible assistant text after a successful channel send', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

    await router.route(inbound({ text: 'say hi' }))
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('SENT')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hi' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('blocked assistant_text_without_channel_tool'))).toBe(false)
  })
})

describe('ChannelRouter consecutive-send accounting', () => {
  test('starts at 0 with no active session for the target', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
  })

  test('increments per successful send to the session origin', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'first' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(1)
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'second' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'third' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(3)
  })

  test('does not increment on failed delivery', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: false, error: 'nope' }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'fail' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
  })

  test('does not increment for cross-post (no live session at target keyId)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c-other', text: 'cross-post' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c-other' })).toBe(0)
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
  })

  test('resets on the next user batch being drained into the model', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'a' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'b' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(2)

    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'c' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(1)
  })

  test('keys per (chat:thread): different threads in the same chat count independently', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound({ thread: 't-A', externalMessageId: 'mA' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })
    await router.route(inbound({ thread: 't-B', externalMessageId: 'mB' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' })

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A', text: 'a1' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A', text: 'a2' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B', text: 'b1' })

    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })).toBe(
      2,
    )
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' })).toBe(
      1,
    )
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

  test('clears the typing heartbeat on stop', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: number[] = []
    router.registerTyping('discord-bot', async () => {
      calls.push(1)
    })
    await router.route(inbound())
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.stop()
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })
})

describe('ChannelRouter commands', () => {
  test('/stop clears a queued channel turn before it reaches the agent', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'please do this' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.route(inbound({ text: '/stop', externalMessageId: 'm-stop' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.prompts).toEqual([])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('/stop aborts an in-flight channel turn without prompting on the command text', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    let releasePrompt: (() => void) | undefined

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => sessions[0]!.prompts.length === 1)

    await router.route(inbound({ text: '/stop', externalMessageId: 'm-stop' }))
    releasePrompt!()
    await draining

    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('long task')
  })

  test('unknown commands are consumed instead of sent as prompts', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: '/unknown arg' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(0)
  })

  test('/stop on a cold channel is consumed without creating a session', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: '/stop' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(0)
  })
})

describe('ChannelRouter typing indicator', () => {
  test('does not fire typing for an observe-only inbound', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string }> = []
    router.registerTyping('discord-bot', async (target) => {
      calls.push({ chat: target.chat })
    })
    // Prime with carol (mention) so alice's next plain message hits the
    // strict gate and observes (the test contract).
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol' }))
    await router.__testing!.flushDebounce(KEY)
    calls.length = 0
    await router.route(inbound({ isBotMention: false, text: 'unrelated' }))
    expect(calls).toHaveLength(0)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('fires typing immediately when an engaged inbound arrives', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string; thread: string | null | undefined }> = []
    router.registerTyping('discord-bot', async (target) => {
      calls.push({ chat: target.chat, thread: target.thread })
    })
    await router.route(inbound({ text: 'hi bot' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ chat: 'c1', thread: null })
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
  })

  test('repeats typing every heartbeat tick while still draining', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: number[] = []
    router.registerTyping('discord-bot', async () => {
      calls.push(1)
    })
    await router.route(inbound({ text: 'hi bot' }))
    expect(calls).toHaveLength(1)
    await router.__testing!.fireTypingHeartbeat(KEY)
    await router.__testing!.fireTypingHeartbeat(KEY)
    expect(calls).toHaveLength(3)
  })

  test('stops the heartbeat after drain completes', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerTyping('discord-bot', async () => {})
    await router.route(inbound({ text: 'hi bot' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.__testing!.flushDebounce(KEY)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('forwards thread id when the inbound is on a thread', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string; thread: string | null | undefined }> = []
    router.registerTyping('discord-bot', async (target) => {
      calls.push({ chat: target.chat, thread: target.thread })
    })
    await router.route(inbound({ thread: 'thread-7', text: 'hi bot' }))
    expect(calls[0]).toEqual({ chat: 'c1', thread: 'thread-7' })
  })

  test('typing-callback rejection does not crash route', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerTyping('discord-bot', async () => {
      throw new Error('discord 503')
    })
    await router.route(inbound({ text: 'hi bot' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.__testing!.flushDebounce(KEY)
  })

  test('fires nothing when no typing callback is registered', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    await router.route(inbound({ text: 'hi bot' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.__testing!.flushDebounce(KEY)
  })

  test('unregisterTyping prevents further heartbeats', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: number[] = []
    const cb = async () => {
      calls.push(1)
    }
    router.registerTyping('discord-bot', cb)
    await router.route(inbound({ text: 'hi bot' }))
    expect(calls).toHaveLength(1)
    router.unregisterTyping('discord-bot', cb)
    await router.__testing!.fireTypingHeartbeat(KEY)
    expect(calls).toHaveLength(1)
  })
})

describe('ChannelRouter plugin lifecycle hooks', () => {
  function makeRouterWithHooks(
    agentDir: string,
    events: string[],
    options: { transcriptPath?: string } = {},
  ): { router: ChannelRouter; sessions: FakeSession[] } {
    const sessions: FakeSession[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async (e) => {
        events.push(`end:${e.sessionId}`)
      },
      runSessionIdle: async (e) => {
        events.push(`idle:${e.sessionId}:${e.parentTranscriptPath ?? '-'}`)
      },
      runSessionPrompt: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir,
      configForAdapter: () => baseConfig,
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
          hooks,
          getTranscriptPath: () => options.transcriptPath,
        }
      },
    })
    return { router, sessions }
  }

  test('fires session.idle after each prompt completion with the transcript path', async () => {
    // given
    const dir = await tempDir()
    const events: string[] = []
    const { router, sessions } = makeRouterWithHooks(dir, events, { transcriptPath: '/tmp/t.jsonl' })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(events).toEqual(['idle:ses_fake_1:/tmp/t.jsonl'])
  })

  test('passes current channel origin and participants to session.idle', async () => {
    // given
    const dir = await tempDir()
    const idleEvents: SessionIdleEvent[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async () => {},
      runSessionIdle: async (e) => {
        idleEvents.push(e)
      },
      runSessionPrompt: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      now: () => 5000,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSessionForChannel: async () => ({
        session: new FakeSession() as unknown as AgentSession,
        sessionId: 'ses_fake_1',
        dispose: async () => {},
        hooks,
        getTranscriptPath: () => '/tmp/t.jsonl',
      }),
    })

    // when
    await router.route(
      inbound({
        adapter: 'slack-bot',
        workspace: 'T123',
        chat: 'C456',
        thread: '171234.0001',
        authorId: 'U1',
        authorName: 'Neo',
      }),
    )
    await router.__testing!.flushDebounce({
      adapter: 'slack-bot',
      workspace: 'T123',
      chat: 'C456',
      thread: '171234.0001',
    })

    // then
    expect(idleEvents).toHaveLength(1)
    expect(idleEvents[0]!.origin).toEqual({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T123',
      chat: 'C456',
      thread: '171234.0001',
      lastInboundAuthorId: 'U1',
      participants: [
        {
          authorId: 'U1',
          authorName: 'Neo',
          firstMessageAt: 5000,
          lastMessageAt: 5000,
          messageCount: 1,
          isBot: false,
        },
      ],
    })
  })

  test('fires session.idle even when prompt throws so plugins still wake up', async () => {
    // given
    const dir = await tempDir()
    const events: string[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async (e) => {
        events.push(`end:${e.sessionId}`)
      },
      runSessionIdle: async (e) => {
        events.push(`idle:${e.sessionId}`)
      },
      runSessionPrompt: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        fake.prompt = async () => {
          throw new Error('llm down')
        }
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_fake_throws',
          dispose: async () => {},
          hooks,
          getTranscriptPath: () => undefined,
        }
      },
    })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(events).toEqual(['idle:ses_fake_throws'])
  })

  test('fires session.end on stop() before disposing each live session', async () => {
    // given
    const dir = await tempDir()
    const events: string[] = []
    const { router, sessions } = makeRouterWithHooks(dir, events)
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when
    await router.stop()

    // then
    expect(events).toEqual(['idle:ses_fake_1:-', 'end:ses_fake_1'])
    expect(sessions[0]!.disposed).toBe(1)
  })
})

describe('ChannelRouter channel name resolver', () => {
  test('calls the registered resolver and forwards resolved names into the session origin', async () => {
    const dir = await tempDir()
    const { router, origins } = makeRouter(dir)
    const calls: ChannelKey[] = []
    router.registerChannelNameResolver('discord-bot', async (key) => {
      calls.push(key)
      return { chatName: 'general', workspaceName: 'Acme Guild' }
    })

    await router.route(inbound())

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(origins).toHaveLength(1)
    const origin = origins[0]!
    if (origin.kind !== 'channel') throw new Error('expected channel origin')
    expect(origin.chatName).toBe('general')
    expect(origin.workspaceName).toBe('Acme Guild')
  })

  test('falls back to undefined names when no resolver is registered', async () => {
    const dir = await tempDir()
    const { router, origins } = makeRouter(dir)

    await router.route(inbound())

    const origin = origins[0]!
    if (origin.kind !== 'channel') throw new Error('expected channel origin')
    expect(origin.chatName).toBeUndefined()
    expect(origin.workspaceName).toBeUndefined()
  })

  test('routes through to undefined names when the resolver throws (does not break session creation)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, origins } = makeRouter(dir, { logs })
    router.registerChannelNameResolver('discord-bot', async () => {
      throw new Error('rate limited')
    })

    await router.route(inbound())

    const origin = origins[0]!
    if (origin.kind !== 'channel') throw new Error('expected channel origin')
    expect(origin.chatName).toBeUndefined()
    expect(origin.workspaceName).toBeUndefined()
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('name resolver'))).toBe(true)
  })

  test('only invokes the resolver matching the inbound adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let discordCalls = 0
    let slackCalls = 0
    router.registerChannelNameResolver('discord-bot', async () => {
      discordCalls++
      return {}
    })
    router.registerChannelNameResolver('slack-bot', async () => {
      slackCalls++
      return {}
    })

    await router.route(inbound({ adapter: 'discord-bot' }))

    expect(discordCalls).toBe(1)
    expect(slackCalls).toBe(0)
  })

  test('does not re-call the resolver on a hot session (only at session creation)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let calls = 0
    router.registerChannelNameResolver('discord-bot', async () => {
      calls++
      return { chatName: 'general', workspaceName: 'Acme' }
    })

    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)

    expect(calls).toBe(1)
  })
})

describe('ChannelRouter peer-bot loop guard', () => {
  function botInbound(over: Partial<InboundMessage> = {}): InboundMessage {
    return inbound({
      authorIsBot: true,
      authorId: 'peer-bot-1',
      authorName: 'peer-bot-1',
      isBotMention: true,
      ...over,
    })
  }

  test('5 consecutive engaged peer-bot turns trip the warning into the next prompt', async () => {
    // given
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })

    // when: 5 engaged peer-bot inbounds, each with its own drain
    for (let i = 0; i < 5; i++) {
      nowRef.value += 100
      await router.route(botInbound({ externalMessageId: `b${i}`, authorId: `peer-${i}`, text: `bot ${i}` }))
      await router.__testing!.flushDebounce(KEY)
    }

    // then
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).toContain('[SYSTEM MESSAGE — not from a human]')
    expect(lastPrompt).toContain('Do not acknowledge or reply to this notice')
    expect(lastPrompt).toContain('NO_REPLY')
  })

  test('slow peer-bot ring (>60s gaps) still trips via since-human counter', async () => {
    // given
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })

    // when: 5 peer bots in a slow ring, each 90s apart so the 60s window stays empty
    for (let i = 0; i < 5; i++) {
      await router.route(botInbound({ externalMessageId: `b${i}`, authorId: `peer-${i}`, text: `bot ${i}` }))
      await router.__testing!.flushDebounce(KEY)
      nowRef.value += 90_000
    }

    // then
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).toContain('[SYSTEM MESSAGE — not from a human]')
  })

  test('a human inbound clears the guard for the next prompt', async () => {
    // given a tripped guard
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    for (let i = 0; i < 5; i++) {
      nowRef.value += 100
      await router.route(botInbound({ externalMessageId: `b${i}`, authorId: `peer-${i}` }))
      await router.__testing!.flushDebounce(KEY)
    }
    expect(sessions[0]!.prompts[sessions[0]!.prompts.length - 1]).toContain('[SYSTEM MESSAGE — not from a human]')

    // when: a human posts
    nowRef.value += 100
    await router.route(inbound({ externalMessageId: 'human-1', text: 'hey bot what now' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    const newest = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(newest).not.toContain('[SYSTEM MESSAGE — not from a human]')
    expect(newest).toContain('hey bot what now')
  })

  test('observed peer-bot messages do not increment the guard', async () => {
    // given a 2-human channel so peer bot messages without mentions OBSERVE
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ authorId: 'alice' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    // when: 10 peer-bot messages with NO mention (must observe in 2-human channel)
    for (let i = 0; i < 10; i++) {
      nowRef.value += 100
      await router.route(
        botInbound({
          externalMessageId: `b${i}`,
          authorId: `peer-${i}`,
          isBotMention: false,
        }),
      )
    }

    // then: a follow-up engaged message must NOT carry the warning
    nowRef.value += 100
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'alice-2', text: 'follow up' }))
    await router.__testing!.flushDebounce(KEY)
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).not.toContain('[SYSTEM MESSAGE — not from a human]')
  })

  test('loop guard notice is fenced as SYSTEM MESSAGE so models do not reply to it', async () => {
    // The bracketed marker, the horizontal rule fences, AND the "Do not
    // acknowledge" line together form the trust boundary that stops persona-rich
    // models (e.g. Kimi) from acknowledging the notice as if it were human
    // speech. Production symptom this guards against:
    // "알겠습니다, Neo! 대화 여기까지 할게요." — the model treating the loop guard
    // heading as Neo telling it to wrap up.

    // given a tripped guard
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    for (let i = 0; i < 5; i++) {
      nowRef.value += 100
      await router.route(botInbound({ externalMessageId: `b${i}`, authorId: `peer-${i}` }))
      await router.__testing!.flushDebounce(KEY)
    }

    // then: the prompt has all three load-bearing pieces of the trust boundary
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).toContain('---')
    expect(lastPrompt).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(lastPrompt).toContain('**Do not acknowledge or reply to this notice.**')
    // and: the old human-readable H2 heading must NOT appear (it was the
    // structural ambiguity that caused the bug)
    expect(lastPrompt).not.toContain('## ⚠️ Loop guard active')
  })

  test('peer-bot author lines are tagged with [bot] in the prompt', async () => {
    // given
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    // when
    await router.route(botInbound({ authorId: 'peer1', authorName: 'PeerBot', text: 'hi from a bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions[0]!.prompts[0]).toContain('<@peer1> (PeerBot) [bot]: hi from a bot')
  })

  test('human author lines are NOT tagged with [bot]', async () => {
    // given
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    // when
    await router.route(inbound({ text: 'hi from alice' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions[0]!.prompts[0]).toContain('<@alice> (alice): hi from alice')
    expect(sessions[0]!.prompts[0]).not.toContain('[bot]')
  })

  test('observed peer-bot messages also carry the [bot] tag in Recent context', async () => {
    // given a 2-human channel where peer-bot messages will observe
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ authorId: 'alice' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    // when: an observed peer bot, then an engaged human
    nowRef.value += 100
    await router.route(
      botInbound({ externalMessageId: 'observed-bot', authorId: 'peer1', authorName: 'PeerBot', isBotMention: false }),
    )
    nowRef.value += 100
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'a2', text: 'ping' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions[0]!.prompts[0]).toContain('<@peer1> (PeerBot) [bot]: ')
  })
})

describe('ChannelRouter history dispatch', () => {
  test('fetchHistory invokes the registered callback with the args verbatim', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const seen: FetchHistoryArgs[] = []
    router.registerHistory('discord-bot', async (args) => {
      seen.push(args)
      return { ok: true, messages: [] }
    })

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: 't1', limit: 5, cursor: 'cur' })

    expect(result).toEqual({ ok: true, messages: [] })
    expect(seen).toEqual([{ chat: 'c1', thread: 't1', limit: 5, cursor: 'cur' }])
  })

  test('returns history-not-supported when no callback is registered for the adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'history-not-supported' })
  })

  test('first ok callback wins; later callbacks are not invoked', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let secondCalled = false
    router.registerHistory('discord-bot', async () => ({
      ok: true,
      messages: [
        {
          externalMessageId: 'm1',
          authorId: 'u1',
          authorName: 'Alice',
          text: 'hi',
          ts: 1000,
          isBot: false,
          replyToBotMessageId: null,
        },
      ],
    }))
    router.registerHistory('discord-bot', async () => {
      secondCalled = true
      return { ok: false, error: 'second' }
    })

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 5 })

    expect(result.ok).toBe(true)
    expect(secondCalled).toBe(false)
  })

  test('surfaces the last error verbatim when every callback returns ok: false', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerHistory('discord-bot', async () => ({ ok: false, error: 'first-failed' }))
    router.registerHistory('discord-bot', async () => ({ ok: false, error: 'second-failed' }))

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'second-failed' })
  })

  test('unregisterHistory removes the callback so subsequent calls fall back to history-not-supported', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const cb: HistoryCallback = async () => ({ ok: true, messages: [] })
    router.registerHistory('discord-bot', cb)
    router.unregisterHistory('discord-bot', cb)

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'history-not-supported' })
  })

  test('history registrations are isolated per adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let discordCalls = 0
    let slackCalls = 0
    router.registerHistory('discord-bot', async () => {
      discordCalls++
      return { ok: true, messages: [] }
    })
    router.registerHistory('slack-bot', async () => {
      slackCalls++
      return { ok: true, messages: [] }
    })

    await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })

    expect(discordCalls).toBe(1)
    expect(slackCalls).toBe(0)
  })
})

function historyMessage(over: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage {
  return {
    externalMessageId: 'h1',
    authorId: 'u1',
    authorName: 'Hist Author',
    text: 'historic',
    ts: 100,
    isBot: false,
    replyToBotMessageId: null,
    ...over,
  }
}

describe('sliceHeadTail', () => {
  const m = (id: string): ChannelHistoryMessage => historyMessage({ externalMessageId: id, text: id })

  test('returns all messages without elision when total <= head + tail', () => {
    const result = sliceHeadTail([m('a'), m('b'), m('c')], 2, 1)
    expect(result.map((s) => (s.kind === 'message' ? s.message.externalMessageId : 'ELIDE'))).toEqual(['a', 'b', 'c'])
  })

  test('elides the middle when total > head + tail', () => {
    const result = sliceHeadTail([m('a'), m('b'), m('c'), m('d'), m('e')], 1, 2)
    expect(result.map((s) => (s.kind === 'message' ? s.message.externalMessageId : `ELIDE:${s.elidedCount}`))).toEqual([
      'a',
      'ELIDE:2',
      'd',
      'e',
    ])
  })

  test('head=0 returns only tail with no elision marker when no head requested', () => {
    const result = sliceHeadTail([m('a'), m('b'), m('c'), m('d')], 0, 2)
    expect(result.map((s) => (s.kind === 'message' ? s.message.externalMessageId : `ELIDE:${s.elidedCount}`))).toEqual([
      'ELIDE:2',
      'c',
      'd',
    ])
  })

  test('tail=0 returns only head', () => {
    const result = sliceHeadTail([m('a'), m('b'), m('c'), m('d')], 2, 0)
    expect(result.map((s) => (s.kind === 'message' ? s.message.externalMessageId : `ELIDE:${s.elidedCount}`))).toEqual([
      'a',
      'b',
      'ELIDE:2',
    ])
  })

  test('both zero returns empty', () => {
    expect(sliceHeadTail([m('a'), m('b')], 0, 0)).toEqual([])
  })

  test('rejects negative head/tail', () => {
    expect(() => sliceHeadTail([m('a')], -1, 0)).toThrow()
    expect(() => sliceHeadTail([m('a')], 0, -1)).toThrow()
  })
})

describe('ChannelRouter cold-start prefetch', () => {
  const THREAD_KEY: ChannelKey = { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' }

  test('prefetches thread history into contextBuffer on a brand-new thread session', async () => {
    // given: a thread cold start with default windows (head=3, tail=10)
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'older1', text: 'thread-opener', authorName: 'Alice' }),
        historyMessage({ externalMessageId: 'mid1', text: 'middle1', authorName: 'Bob' }),
        historyMessage({ externalMessageId: 'mid2', text: 'middle2', authorName: 'Bob' }),
        historyMessage({ externalMessageId: 'recent1', text: 'recent', authorName: 'Carol' }),
      ],
    }))

    // when: an inbound arrives in a fresh thread
    await router.route(inbound({ thread: 't-A', externalMessageId: 'engage1', text: 'hey bot' }))
    await router.__testing!.flushDebounce(THREAD_KEY)

    // then: the composed prompt includes prefetched messages under "Recent context"
    expect(sessions[0]!.prompts).toHaveLength(1)
    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('## Recent context')
    expect(prompt).toContain('thread-opener')
    expect(prompt).toContain('recent')
    expect(prompt).toContain('## Current message')
    expect(prompt).toContain('hey bot')
  })

  test('prefetches channel scrollback (tail-only) when session is not in a thread', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'h1', text: 'channel-msg-1' }),
        historyMessage({ externalMessageId: 'h2', text: 'channel-msg-2' }),
      ],
    }))

    await router.route(inbound({ externalMessageId: 'engage', text: 'help me' }))
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('## Recent context')
    expect(prompt).toContain('channel-msg-1')
    expect(prompt).toContain('channel-msg-2')
  })

  test('reopened session (existing sessionId persisted) skips prefetch', async () => {
    const dir = await tempDir()
    // given: a pre-existing channel→session mapping on disk
    await saveChannelSessions(dir, [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_preexisting',
        participants: [],
      },
    ])
    let historyCalls = 0
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', async () => {
      historyCalls++
      return { ok: true, messages: [historyMessage({ text: 'should-not-appear' })] }
    })

    await router.route(inbound({ externalMessageId: 'engage', text: 'hi' }))
    await router.__testing!.flushDebounce(KEY)

    expect(historyCalls).toBe(0)
    expect(sessions[0]!.prompts[0]).not.toContain('should-not-appear')
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
  })

  test('history fetch failure is non-fatal; session still processes the engaging message', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerHistory('discord-bot', async () => ({ ok: false, error: 'rate-limited' }))

    await router.route(inbound({ externalMessageId: 'engage', text: 'still works' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('still works')
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
    expect(
      logs.some((l) => l.startsWith('warn:') && l.includes('prefetch skipped') && l.includes('rate-limited')),
    ).toBe(true)
  })

  test('no history adapter registered → prefetch quietly skipped, no error', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    // no router.registerHistory call

    await router.route(inbound({ externalMessageId: 'engage', text: 'hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
  })

  test('drops the engaging message itself from prefetched history (dedup by externalMessageId)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'older', text: 'before-engage' }),
        historyMessage({ externalMessageId: 'engage', text: 'engaging-message-duplicated' }),
      ],
    }))

    await router.route(inbound({ externalMessageId: 'engage', text: 'engaging-message-current' }))
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('before-engage')
    expect(prompt).not.toContain('engaging-message-duplicated')
    // the engaging message itself appears exactly once, in the Current section
    expect(prompt).toContain('engaging-message-current')
    const occurrences = prompt.split('engaging-message').length - 1
    expect(occurrences).toBe(1)
  })

  test('emits an elision marker when thread length exceeds head + tail', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, {
      // override defaults to make elision easy to trigger
      config: {
        allow: ['*'],
        engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
        enabled: true,
        history: { prefetch: { thread: { head: 1, tail: 1 }, channel: { tail: 0 } } },
      },
    })
    router.registerHistory('discord-bot', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'h1', text: 'oldest-of-three' }),
        historyMessage({ externalMessageId: 'h2', text: 'middle-of-three' }),
        historyMessage({ externalMessageId: 'h3', text: 'newest-of-three' }),
      ],
    }))

    await router.route(inbound({ thread: 't-A', externalMessageId: 'engage', text: 'hi' }))
    await router.__testing!.flushDebounce(THREAD_KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('oldest-of-three')
    expect(prompt).not.toContain('middle-of-three')
    expect(prompt).toContain('newest-of-three')
    expect(prompt).toContain('1 earlier messages elided')
  })

  test('all prefetch windows zero → no fetch is issued', async () => {
    const dir = await tempDir()
    let historyCalls = 0
    const { router, sessions } = makeRouter(dir, {
      config: {
        allow: ['*'],
        engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
        enabled: true,
        history: { prefetch: { thread: { head: 0, tail: 0 }, channel: { tail: 0 } } },
      },
    })
    router.registerHistory('discord-bot', async () => {
      historyCalls++
      return { ok: true, messages: [historyMessage({ text: 'never-fetched' })] }
    })

    await router.route(inbound({ externalMessageId: 'engage', text: 'hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(historyCalls).toBe(0)
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
  })

  test('passes thread-scoped fetch args (thread id, head+tail+1 limit) on thread cold start', async () => {
    const dir = await tempDir()
    const captured: FetchHistoryArgs[] = []
    const { router } = makeRouter(dir, {
      config: {
        allow: ['*'],
        engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
        enabled: true,
        history: { prefetch: { thread: { head: 2, tail: 5 }, channel: { tail: 8 } } },
      },
    })
    router.registerHistory('discord-bot', async (args) => {
      captured.push(args)
      return { ok: true, messages: [] }
    })

    await router.route(inbound({ thread: 't-A', externalMessageId: 'engage', text: 'hi' }))
    await router.__testing!.flushDebounce(THREAD_KEY)

    expect(captured).toEqual([{ chat: 'c1', thread: 't-A', limit: 8 }])
  })
})

// Idle GC evicts LiveSessions whose lastInboundAt is older than
// SESSION_IDLE_MS. Persistence (channels/sessions.json) is intentionally
// untouched: the next inbound rehydrates from disk against the same
// sessionId, so the agent gets a fresh in-memory session but the on-disk
// transcript continues. Tests drive the GC via the `__testing.runIdleGc()`
// seam; production uses a setInterval.
describe('ChannelRouter idle session GC', () => {
  test('evicts a session that has been idle longer than SESSION_IDLE_MS', async () => {
    // given: an engaged session at t=1000 (creates the session)
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.liveCount()).toBe(1)

    // when: time advances past the idle threshold and the GC runs
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: live map drops the entry, the session is aborted+disposed
    expect(router.liveCount()).toBe(0)
    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.disposed).toBe(1)
  })

  test('does not evict a session whose lastInboundAt is within SESSION_IDLE_MS', async () => {
    // given
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when: advance time but stay just under the threshold
    nowRef.value = 1000 + SESSION_IDLE_MS - 1
    await router.__testing!.runIdleGc!()

    // then
    expect(router.liveCount()).toBe(1)
    expect(sessions[0]!.aborted).toBe(0)
  })

  test('does not evict a session that is currently draining', async () => {
    // given: a session whose prompt() blocks until we release it
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    let release: (() => void) | undefined
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ text: 'hi bot' }))
    sessions[0]!.onPrompt = async () => {
      await blocked
    }
    const draining = router.__testing!.flushDebounce(KEY)

    // when: time leaps past the threshold while the turn is in flight
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: GC respects the in-flight turn and leaves the session alone
    expect(router.liveCount()).toBe(1)
    expect(sessions[0]!.aborted).toBe(0)

    // cleanup so the test process can exit
    release!()
    await draining
  })

  test('next inbound after eviction creates a fresh session and rehydrates the persisted sessionId', async () => {
    // given: session is evicted
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()
    expect(router.liveCount()).toBe(0)

    // when
    await router.route(inbound({ text: 'still here?', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions).toHaveLength(2)
    expect(router.liveCount()).toBe(1)
    const persisted = await loadChannelSessions(dir)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.sessionId).toBeDefined()
  })

  test('fires session.end hook on the evicted session before disposing', async () => {
    // given: a session with hooks
    const dir = await tempDir()
    const events: string[] = []
    const nowRef = { value: 1000 }
    const sessions: FakeSession[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async (e) => {
        events.push(`end:${e.sessionId}`)
      },
      runSessionIdle: async (e) => {
        events.push(`idle:${e.sessionId}`)
      },
      runSessionPrompt: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
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
          hooks,
          getTranscriptPath: () => undefined,
        }
      },
    })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: idle fires after the prompt (existing behavior), then end on
    // eviction; end must precede dispose so plugins can still touch state.
    expect(events).toEqual(['idle:ses_fake_1', 'end:ses_fake_1'])
    expect(sessions[0]!.disposed).toBe(1)
  })

  test('runIdleGc tolerates dispose throwing and still removes the entry', async () => {
    // given
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const sessions: FakeSession[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      now: () => nowRef.value,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        sessions.push(fake)
        return {
          session: fake as unknown as AgentSession,
          sessionId: `ses_fake_${sessions.length}`,
          dispose: async () => {
            throw new Error('dispose boom')
          },
        }
      },
    })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then
    expect(router.liveCount()).toBe(0)
    expect(logs.some((l) => l.includes('dispose'))).toBe(true)
  })
})
