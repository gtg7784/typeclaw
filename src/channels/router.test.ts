import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile as writeFileFs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { AssistantMessage } from '@mariozechner/pi-ai'
import type { SessionEntry } from '@mariozechner/pi-coding-agent'

import type { AgentSession } from '@/agent'
import type { SessionOrigin } from '@/agent/session-origin'
import type { PermissionService } from '@/permissions'
import type { HookBus, SessionIdleEvent } from '@/plugin'

import { channelsSessionsPath, loadChannelSessions, saveChannelSessions } from './persistence'
import {
  createChannelRouter,
  DUPLICATE_SEND_ERROR,
  MAX_CHANNEL_SENDS_PER_TURN,
  MAX_TYPING_HEARTBEAT_MS,
  SEND_RATE_WARN_THRESHOLD,
  SEND_RATE_WINDOW_MS,
  SESSION_GC_INTERVAL_MS,
  SESSION_FRESHNESS_TTL_MS,
  SESSION_IDLE_MS,
  sliceHeadTail,
  TURN_CAP_ERROR,
  type ChannelRouter,
  type ClaimHandler,
} from './router'
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

  private subscribers = new Set<(event: { type: string; message?: unknown }) => void>()

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
  subscribe = (cb: (event: { type: string; message?: unknown }) => void): (() => void) => {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }
  emit = (event: { type: string; message?: unknown }): void => {
    for (const cb of this.subscribers) cb(event)
  }

  setAssistantText(text: string): void {
    this.leafEntry = messageEntry(assistantMessage(text))
  }

  setAssistantMessage(message: AssistantMessage): void {
    this.leafEntry = messageEntry(message)
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
  engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
  enabled: true,
  history: defaultHistoryConfig(),
}

type SessionFactoryArgs = {
  existingSessionId?: string
  existingSessionFile?: string
}

// Test-only permission service that grants `channel.respond` to everyone.
// Most router tests don't exercise the gate; they need a permissive service
// so the router actually routes. Suites that test the gate inject their
// own.
const grantAllPermissions: PermissionService = {
  has: () => true,
  resolveRole: () => 'owner',
  describe: () => ({ role: 'owner', permissions: ['channel.respond'] }),
  replaceRoles: () => {},
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
    ensureLiveTimeoutMs?: number
    permissions?: PermissionService
    claimHandler?: ClaimHandler
    hooks?: HookBus
  } = {},
): { router: ChannelRouter; sessions: FakeSession[]; origins: SessionOrigin[] } {
  const sessions: FakeSession[] = options.sessions ?? []
  const origins: SessionOrigin[] = options.origins ?? []
  const nowRef = options.nowRef ?? { value: 1000 }
  const router = createChannelRouter({
    agentDir,
    configForAdapter: () => options.config ?? baseConfig,
    ...(options.configuredAliases !== undefined ? { configuredAliases: options.configuredAliases } : {}),
    ...(options.ensureLiveTimeoutMs !== undefined ? { ensureLiveTimeoutMs: options.ensureLiveTimeoutMs } : {}),
    ...(options.claimHandler !== undefined ? { claimHandler: options.claimHandler } : {}),
    permissions: options.permissions ?? grantAllPermissions,
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
        ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
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

async function waitForPersistedLastInboundAt(agentDir: string, expected: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const loaded = await loadChannelSessions(agentDir)
    if (loaded[0]?.lastInboundAt === expected) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const loaded = await loadChannelSessions(agentDir)
  throw new Error(`lastInboundAt persisted as ${String(loaded[0]?.lastInboundAt)}, expected ${expected}`)
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

  test('emits ordered ensureLive phase logs bracketing each await', async () => {
    // given a fresh router and a captured log buffer
    const dir = await tempDir()
    const logs: string[] = []
    const { router } = makeRouter(dir, { logs })

    // when a first inbound triggers cold-start ensureLive
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    // then phase logs appear in order: begin → resolved-names → resolved-membership
    //   → session-created → done. The bracketing is what makes a stuck phase
    //   visible from logs alone (begin without done == hung at that phase).
    const phaseLogs = logs
      .filter((l) => l.startsWith('info:[channels]') && l.includes('ensureLive'))
      .map((l) => l.replace(/^.*ensureLive /, ''))
    const beginIdx = phaseLogs.findIndex((p) => p.startsWith('begin'))
    const namesIdx = phaseLogs.findIndex((p) => p.startsWith('resolved-names'))
    const membershipIdx = phaseLogs.findIndex((p) => p.startsWith('resolved-membership'))
    const createdIdx = phaseLogs.findIndex((p) => p.startsWith('session-created'))
    const doneIdx = phaseLogs.findIndex((p) => p.startsWith('done'))
    expect(beginIdx).toBeGreaterThanOrEqual(0)
    expect(namesIdx).toBeGreaterThan(beginIdx)
    expect(membershipIdx).toBeGreaterThan(namesIdx)
    expect(createdIdx).toBeGreaterThan(membershipIdx)
    expect(doneIdx).toBeGreaterThan(createdIdx)
    expect(phaseLogs[beginIdx]).toContain('cold-start')
    expect(phaseLogs[doneIdx]).toContain('cold-start')
  })

  test('rehydrate path logs `ensureLive begin (rehydrate)` after restart', async () => {
    // given a persisted mapping from a prior run
    const dir = await tempDir()
    const firstRun = makeRouter(dir)
    await firstRun.router.route(inbound())
    await firstRun.router.__testing!.flushDebounce(KEY)
    await firstRun.router.stop()

    // when a fresh router (simulating restart) handles a new inbound for the same channel
    const logs: string[] = []
    const secondRun = makeRouter(dir, { logs })
    await secondRun.router.route(inbound({ externalMessageId: 'm-rehydrate' }))
    await secondRun.router.__testing!.flushDebounce(KEY)

    // then the begin and done logs both flag the rehydrate path
    const phaseLogs = logs.filter((l) => l.includes('ensureLive'))
    expect(phaseLogs.some((l) => l.includes('begin (rehydrate)'))).toBe(true)
    expect(phaseLogs.some((l) => l.includes('done (rehydrate)'))).toBe(true)
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

  test('after SESSION_FRESHNESS_TTL_MS + 1ms idle, next inbound creates new sessionId', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'still there?' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(2)
    const loaded = await loadChannelSessions(dir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.sessionId).toBe('ses_fake_2')
    expect(loaded[0]?.lastInboundAt).toBe(1000 + SESSION_FRESHNESS_TTL_MS + 1)
  })

  test('at exactly SESSION_FRESHNESS_TTL_MS, next inbound reuses session', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS
    await router.route(inbound({ externalMessageId: 'm2', text: 'boundary check' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(1)
    await waitForPersistedLastInboundAt(dir, 1000 + SESSION_FRESHNESS_TTL_MS)
    const loaded = await loadChannelSessions(dir)
    expect(loaded[0]?.sessionId).toBe('ses_fake_1')
    expect(loaded[0]?.lastInboundAt).toBe(1000 + SESSION_FRESHNESS_TTL_MS)
  })

  test('stale rollover fires session.end on old session', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const events: string[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async (e) => {
        events.push(`end:${e.sessionId}`)
      },
      runSessionIdle: async () => {},
      runSessionPrompt: async () => {},
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const { router, sessions } = makeRouter(dir, { nowRef, hooks })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'roll over' }))
    await router.__testing!.flushDebounce(KEY)

    expect(events).toContain('end:ses_fake_1')
    expect(sessions[0]!.disposed).toBe(1)
    expect(sessions).toHaveLength(2)
  })

  test('lastInboundAt persisted to sessions.json after every engaged inbound', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })

    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)
    await waitForPersistedLastInboundAt(dir, 1000)

    nowRef.value = 2000
    await router.route(inbound({ externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)
    await waitForPersistedLastInboundAt(dir, 2000)
  })

  test('v3-loaded record with lastInboundAt=0 forces rollover on first inbound', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFileFs(
      channelsSessionsPath(dir),
      JSON.stringify({
        version: 3,
        sessions: [
          {
            adapter: 'discord-bot',
            workspace: 'g1',
            chat: 'c1',
            thread: null,
            sessionId: 'ses_legacy',
            sessionFile: 'legacy.jsonl',
            participants: [],
          },
        ],
      }),
    )
    const factoryCalls: SessionFactoryArgs[] = []
    const nowRef = { value: SESSION_FRESHNESS_TTL_MS + 1 }
    const { router, sessions } = makeRouter(dir, { nowRef, factoryCalls })

    await router.route(inbound({ externalMessageId: 'm-upgrade', text: 'post-upgrade' }))
    await router.__testing!.flushDebounce(KEY)

    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBeUndefined()
    expect(factoryCalls[0]?.existingSessionFile).toBeUndefined()
    expect(sessions).toHaveLength(1)
    const loaded = await loadChannelSessions(dir)
    expect(loaded[0]?.sessionId).toBe('ses_fake_1')
    expect(loaded[0]?.lastInboundAt).toBe(SESSION_FRESHNESS_TTL_MS + 1)
  })

  test('command path does NOT trigger rollover', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm-stop', text: '/stop' }))

    expect(sessions).toHaveLength(1)
    expect(logs.some((l) => l.includes('stale-rollover'))).toBe(false)

    await router.route(inbound({ externalMessageId: 'm2', text: 'now answer' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(2)
    expect(logs.some((l) => l.includes('stale-rollover'))).toBe(true)
  })
})

describe('ChannelRouter ensureLive watchdog', () => {
  test('hung session factory rejects after the timeout instead of awaiting forever', async () => {
    // given a factory that never resolves (simulates a hung Discord REST chain
    // inside createForChannel — the production failure mode that bricked the
    // bot for 2 days when a previously-evicted channel got a new inbound
    // during a gateway-disconnect storm)
    const dir = await tempDir()
    const logs: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      ensureLiveTimeoutMs: 50,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: () => new Promise(() => {}),
    })

    // when the route promise resolves (the adapter's outer catch is responsible
    // for swallowing the thrown timeout in production; here we observe the
    // throw directly to assert the watchdog actually fired)
    const start = Date.now()
    await expect(router.route(inbound())).rejects.toThrow(/ensureLive timed out after 50ms/)
    const elapsed = Date.now() - start

    // then we returned within the watchdog window (production-relevant: the
    // adapter's outer catch sees the timeout error promptly and decrements
    // its inflight counter, instead of sitting forever)
    expect(elapsed).toBeLessThan(500)
    expect(logs.some((l) => l.includes('error:[channels]') && l.includes('ensureLive failed'))).toBe(true)
  })

  test('after a watchdog timeout, the next inbound retries instead of awaiting the dead promise', async () => {
    // given a factory that hangs the FIRST call but resolves the second.
    // This is the diagnostic that proves the `creating` map entry was evicted
    // — the original bug had every subsequent message await the same dead
    // promise from the first hung call (commit message reproduces from logs).
    const dir = await tempDir()
    const logs: string[] = []
    let callCount = 0
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      ensureLiveTimeoutMs: 50,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: async () => {
        callCount++
        if (callCount === 1) await new Promise(() => {})
        const fake = new FakeSession()
        return {
          session: fake as unknown as AgentSession,
          sessionId: `ses_retry_${callCount}`,
          dispose: async () => {
            fake.dispose()
          },
        }
      },
    })

    // when first inbound times out, then a second inbound arrives
    await expect(router.route(inbound())).rejects.toThrow(/ensureLive timed out/)
    expect(logs.some((l) => l.includes('ensureLive failed'))).toBe(true)
    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    // then the factory was called twice (proving the creating-map entry was
    // evicted on timeout) and the second call succeeded into a live session
    expect(callCount).toBe(2)
    expect(router.liveCount()).toBe(1)
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

  test('logs an `observed id=...` line when engagement decides observe', async () => {
    // given a 2-human channel under strict trigger so a non-mention observes
    const dir = await tempDir()
    const logs: string[] = []
    const { router } = makeRouter(dir, {
      config: {
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      },
      logs,
    })
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol' }))
    await router.__testing!.flushDebounce(KEY)

    // when a non-mention from a different author arrives (must observe)
    logs.length = 0
    await router.route(inbound({ isBotMention: false, externalMessageId: 'm-observed' }))

    // then exactly one observed log is emitted with the inbound message id
    const observedLogs = logs.filter((l) => l.includes('observed id='))
    expect(observedLogs).toHaveLength(1)
    expect(observedLogs[0]).toContain('id=m-observed')
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

  test('allows (NO_REPLY) with parens as a silent-turn signal', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'just FYI' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('(NO_REPLY)')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test('allows empty visible text (thinking-only response) as a silent-turn signal', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'just FYI' }))
    sessions[0]!.onPrompt = () => {
      // given: assistant message with only a thinking block, no visible text
      // (e.g. Kimi-distilled models that end the turn after thinking)
      sessions[0]!.setAssistantMessage({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'no need to respond' }],
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
      })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
    expect(sent).toHaveLength(0)
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

describe('ChannelRouter duplicate-send guard', () => {
  test('first send delivers; second identical send is blocked with code=duplicate', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => {
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const first = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })
    expect(first).toEqual({ ok: true })

    const second = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })
    expect(second).toEqual({ ok: false, error: DUPLICATE_SEND_ERROR, code: 'duplicate' })
    expect(delivered).toBe(1)
  })

  test('lets a different body through after a recent dup', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'first' })
    const second = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'second' })
    expect(second).toEqual({ ok: true })
  })

  test('failed delivery does not reserve a dup slot — retry with same text succeeds', async () => {
    const dir = await tempDir()
    let attempts = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => {
      attempts++
      return attempts === 1 ? { ok: false, error: 'transient' } : { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const first = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'flaky' })
    expect(first.ok).toBe(false)
    const retry = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'flaky' })
    expect(retry).toEqual({ ok: true })
  })

  test('resets on the next user batch so across-turn repeats are not blocked', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    const a = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'yes I am here' })
    expect(a).toEqual({ ok: true })

    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    const b = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'yes I am here' })
    expect(b).toEqual({ ok: true })
  })

  test('scopes per (chat:thread): same text to a different thread is not flagged', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound({ thread: 't-A', externalMessageId: 'mA' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })
    await router.route(inbound({ thread: 't-B', externalMessageId: 'mB' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' })

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A', text: 'shared' })
    const b = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: 't-B',
      text: 'shared',
    })
    expect(b).toEqual({ ok: true })
  })

  test('attachments-only sends (text undefined) do not poison the dup tracker', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      attachments: [{ path: '/agent/file.png' }],
    })
    await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      attachments: [{ path: '/agent/file2.png' }],
    })
    // Both succeed; empty-string normalization means attachments-only never sets lastSentText.
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(2)
  })

  test('empty string text is normalized — does not block a follow-up empty-text send', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: '',
      attachments: [{ path: '/agent/a.png' }],
    })
    const second = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: '',
      attachments: [{ path: '/agent/b.png' }],
    })
    expect(second).toEqual({ ok: true })
  })

  test('parallel router.send for same text — only one delivers, the rest are duplicate-denied', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => {
      // simulate a tiny adapter latency so all 10 sends are in flight at the same time
      await new Promise((resolve) => setTimeout(resolve, 5))
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const N = 10
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'same-text' }),
      ),
    )
    const okCount = results.filter((r) => r.ok).length
    const dupCount = results.filter((r) => !r.ok && r.code === 'duplicate').length
    expect(okCount).toBe(1)
    expect(dupCount).toBe(N - 1)
    expect(delivered).toBe(1)
  })

  test('system-source send bypasses the duplicate guard (recovery path)', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => {
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })
    const sys = await router.send(
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' },
      { source: 'system' },
    )
    expect(sys).toEqual({ ok: true })
    expect(delivered).toBe(2)
  })
})

describe('ChannelRouter per-turn send cap', () => {
  test('blocks the (cap+1)th tool send with code=turn-cap', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    for (let i = 0; i < MAX_CHANNEL_SENDS_PER_TURN; i++) {
      const r = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `msg-${i}` })
      expect(r).toEqual({ ok: true })
    }
    const overflow = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: `msg-${MAX_CHANNEL_SENDS_PER_TURN}`,
    })
    expect(overflow).toEqual({ ok: false, error: TURN_CAP_ERROR, code: 'turn-cap' })
  })

  test('cap resets on the next user batch', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    for (let i = 0; i < MAX_CHANNEL_SENDS_PER_TURN; i++) {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `pre-${i}` })
    }
    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    const fresh = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'post' })
    expect(fresh).toEqual({ ok: true })
  })

  test('system-source bypasses the cap', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    for (let i = 0; i < MAX_CHANNEL_SENDS_PER_TURN; i++) {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `t-${i}` })
    }
    const sys = await router.send(
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'recovery' },
      { source: 'system' },
    )
    expect(sys).toEqual({ ok: true })
  })

  test('parallel router.send for distinct text — at most cap deliveries; the rest turn-capped', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const N = MAX_CHANNEL_SENDS_PER_TURN + 5
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `distinct-${i}` }),
      ),
    )
    const okCount = results.filter((r) => r.ok).length
    const capCount = results.filter((r) => !r.ok && r.code === 'turn-cap').length
    expect(okCount).toBe(MAX_CHANNEL_SENDS_PER_TURN)
    expect(capCount).toBe(N - MAX_CHANNEL_SENDS_PER_TURN)
    expect(delivered).toBe(MAX_CHANNEL_SENDS_PER_TURN)
  })
})

describe('ChannelRouter getSendRate', () => {
  test('reports zero with no active session for the target', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toEqual({
      count: 0,
      windowMs: SEND_RATE_WINDOW_MS,
    })
  })

  test('counts every send inside the rolling window', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'a' })
    nowRef.value += 100
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'b' })
    nowRef.value += 100
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'c' })
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }).count).toBe(3)
  })

  test('prunes timestamps older than the window on every read', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'a' })
    nowRef.value += SEND_RATE_WINDOW_MS + 1
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'b' })
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }).count).toBe(1)
  })

  test('survives turn boundaries: rate is wall-clock, not turn-clock', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'a' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'b' })
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }).count).toBe(2)

    nowRef.value += 500
    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }).count).toBe(2)
  })

  test('scopes per (chat:thread): different threads count independently', async () => {
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

    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' }).count).toBe(2)
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' }).count).toBe(1)
  })

  test('emits a structured per-send log line for every successful send', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })

    const sendLog = logs.find((m) => m.includes('[channels]') && m.includes(': send source='))
    expect(sendLog).toBeDefined()
    expect(sendLog).toContain('source=tool')
    expect(sendLog).toContain('turn=1')
    expect(sendLog).toContain('rate=1/')
    expect(sendLog).toContain('text_len=5')
  })

  test('flags a burst with send_rate_warning once rate crosses the warn threshold', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router } = makeRouter(dir, { nowRef, logs })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    for (let i = 0; i < SEND_RATE_WARN_THRESHOLD - 1; i++) {
      nowRef.value += 50
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `pre-${i}` })
    }
    expect(logs.some((m) => m.includes('send_rate_warning'))).toBe(false)

    nowRef.value += 50
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'burst' })

    const warn = logs.find((m) => m.startsWith('warn:') && m.includes('send_rate_warning'))
    expect(warn).toBeDefined()
    expect(warn).toContain(`rate=${SEND_RATE_WARN_THRESHOLD}/${SEND_RATE_WINDOW_MS}ms`)
  })

  test('system-source sends are logged with source=system', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'recovery' }, { source: 'system' })
    const sysLog = logs.find((m) => m.includes(': send source=system'))
    expect(sysLog).toBeDefined()
  })
})

describe('ChannelRouter cross-tool sharing', () => {
  test('first send via channel_reply blocks a follow-up channel_send with the same text', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let delivered = 0
    router.registerOutbound('discord-bot', async () => {
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const first = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'shared' })
    expect(first).toEqual({ ok: true })

    const second = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'shared' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('duplicate')
    expect(delivered).toBe(1)
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

  test('fires phase=stop exactly once when drain completes (so adapters can clear)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })
    // when
    await router.route(inbound({ text: 'hi bot' }))
    expect(phases).toEqual(['tick'])
    await router.__testing!.flushDebounce(KEY)
    // then
    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('awaits phase=stop when a turn is dropped without an outbound reply', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    let releaseStop: (() => void) | undefined
    let flushResolved = false
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
      if (target.phase === 'stop') {
        await new Promise<void>((resolve) => {
          releaseStop = resolve
        })
      }
    })

    await router.route(inbound({ text: 'hi bot' }))
    const flushed = router.__testing!.flushDebounce(KEY).then(() => {
      flushResolved = true
    })
    await waitFor(() => releaseStop !== undefined)

    expect(flushResolved).toBe(false)
    expect(phases).toEqual(['tick', 'stop'])
    releaseStop!()
    await flushed
    expect(flushResolved).toBe(true)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('a later teardown awaits a stop already started by the heartbeat interval', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    let releasePrompt: (() => void) | undefined
    let releaseStop: (() => void) | undefined
    let flushResolved = false
    router.registerTyping('discord-bot', async (target) => {
      if (target.phase === 'stop') {
        await new Promise<void>((resolve) => {
          releaseStop = resolve
        })
      }
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY).then(() => {
      flushResolved = true
    })
    await waitFor(() => releasePrompt !== undefined)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS

    const interval = router.__testing!.fireTypingInterval(KEY)
    await waitFor(() => releaseStop !== undefined)

    expect(flushResolved).toBe(false)
    releasePrompt!()
    releaseStop!()
    await Promise.all([interval, draining])
    expect(flushResolved).toBe(true)
  })

  test('stops and clears typing after the max heartbeat window while a turn is still draining', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS

    await router.__testing!.fireTypingInterval(KEY)

    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
    expect(logs.some((m) => m.includes('typing heartbeat timed out'))).toBe(true)

    releasePrompt!()
    await draining
    expect(phases).toEqual(['tick', 'stop'])
  })

  test('does not restart typing after timeout for a later inbound during the same in-flight turn', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    let promptCount = 0
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      promptCount++
      if (promptCount > 1) return
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    await router.__testing!.fireTypingInterval(KEY)

    await router.route(inbound({ text: 'still there?', externalMessageId: 'm2' }))

    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)

    releasePrompt!()
    await draining
  })

  test('a successful mid-turn channel send keeps typing active so the agent can send again', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'done' })
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    expect(phases).toEqual(['tick', 'tick'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)

    releasePrompt!()
    await draining
    expect(phases).toEqual(['tick', 'tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('typing heartbeat keeps ticking across two mid-turn channel sends', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'okay, checking' })
      await router.__testing!.fireTypingInterval(KEY)
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here is what I got' })
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    expect(phases).toEqual(['tick', 'tick', 'tick', 'tick'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)

    releasePrompt!()
    await draining
    expect(phases).toEqual(['tick', 'tick', 'tick', 'tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('a successful mid-turn send fires a fresh tick after the outbound completes', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const events: string[] = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', async (target) => {
      events.push(`typing:${target.phase}`)
    })
    router.registerOutbound('discord-bot', async () => {
      events.push('outbound:cb')
      return { ok: true }
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    expect(events).toEqual(['typing:tick', 'outbound:cb', 'typing:tick'])

    releasePrompt!()
    await draining
  })

  test('mid-turn re-arm tick is suppressed when the heartbeat was stopped during the outbound', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', async (_msg) => {
      // simulate teardown happening during the outbound: the heartbeat is
      // stopped after the adapter accepted the send but before send()
      // returns. The re-arm guard must suppress the post-send tick so we
      // don't resurrect typing.
      await router.__testing!.stopTyping(KEY)
      return { ok: true }
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // initial route() tick + stopTyping's 'stop'. No extra 'tick' after the send.
    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)

    releasePrompt!()
    await draining
  })

  test('phase=stop carries the same chat/thread coordinates as ticks', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const stopTargets: Array<{ chat: string; thread: string | null | undefined }> = []
    router.registerTyping('discord-bot', async (target) => {
      if (target.phase === 'stop') stopTargets.push({ chat: target.chat, thread: target.thread })
    })
    await router.route(inbound({ thread: 'thread-7', text: 'hi bot' }))
    await router.__testing!.flushDebounce({ ...KEY, thread: 'thread-7' })
    expect(stopTargets).toEqual([{ chat: 'c1', thread: 'thread-7' }])
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
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
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
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
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
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
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

  test('logs LLM soft errors (stopReason=error encoded in message_end) so `typeclaw logs` surfaces them', async () => {
    // given: a live session whose prompt() resolves normally but emits a
    // message_end with stopReason=error mid-turn — pi-coding-agent's
    // documented way of reporting billing/rate-limit failures without
    // throwing. Without the router subscribing, this would be invisible
    // (no reply to the channel, no entry in `typeclaw logs`).
    const dir = await tempDir()
    const errors: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        fake.prompt = async (_text) => {
          fake.emit({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'billing not active',
            },
          })
        }
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_soft_err',
          dispose: async () => {},
          getTranscriptPath: () => undefined,
        }
      },
    })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(errors.some((m) => /LLM call failed: billing not active/.test(m))).toBe(true)
  })

  test('upgrades hard prompt-throws to logger.error (not warn) so `typeclaw logs` operators see them at the right level', async () => {
    // given
    const dir = await tempDir()
    const warns: string[] = []
    const errors: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      logger: {
        info: () => {},
        warn: (m) => warns.push(m),
        error: (m) => errors.push(m),
      },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        fake.prompt = async () => {
          throw new Error('network unreachable')
        }
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_hard_err',
          dispose: async () => {},
          getTranscriptPath: () => undefined,
        }
      },
    })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(errors.some((m) => /prompt threw.*network unreachable/.test(m))).toBe(true)
    expect(warns.some((m) => /prompt threw/.test(m))).toBe(false)
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

  test('a hung session.idle hook does not wedge the drain loop forever', async () => {
    // given a session.idle hook that never resolves (production failure
    // mode: a plugin handler awaiting a network call that hangs). Without
    // the watchdog, `live.draining` would stay `true` and every subsequent
    // mention would silently enqueue forever. The test seam shortens the
    // chain ceiling so the path is exercisable in milliseconds.
    const dir = await tempDir()
    const sessions: FakeSession[] = []
    const logs: string[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async () => {},
      runSessionIdle: () => new Promise(() => {}),
      runSessionPrompt: async () => {},
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      sessionIdleTimeoutMs: 30,
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
            fake.dispose()
          },
          hooks,
          getTranscriptPath: () => undefined,
        }
      },
    })

    // when a first message engages the bot and a second arrives after the
    // idle-hook watchdog should have fired
    const start = Date.now()
    await router.route(inbound({ text: 'first' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)
    const elapsed = Date.now() - start

    // then both prompts ran (the second is the real proof — without the
    // watchdog the drain loop would still be parked inside the hung idle
    // hook and `live.draining` would block enqueue from firing a new drain),
    // the run completed within the watchdog window, and a warning naming
    // the timeout was emitted so an operator can attribute the hang
    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(elapsed).toBeLessThan(2000)
    const idleWarn = logs.find((l) => l.includes('warn:[channels]') && l.includes('session.idle hook threw'))
    expect(idleWarn).toBeDefined()
    expect(idleWarn).toMatch(/session\.idle timed out after 30ms/)
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

  test('a hung name resolver times out without dragging ensureLive past the per-callback ceiling', async () => {
    // given a name resolver that never resolves (production failure mode:
    // Discord REST stuck during a gateway-disconnect storm)
    const dir = await tempDir()
    const logs: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      resolveChannelNamesTimeoutMs: 50,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_after_timeout',
          dispose: async () => {
            fake.dispose()
          },
        }
      },
    })
    router.registerChannelNameResolver('discord-bot', () => new Promise(() => {}))

    // when an inbound triggers ensureLive
    const start = Date.now()
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    const elapsed = Date.now() - start

    // then ensureLive completes without the resolved name (graceful
    // degradation), the timeout is logged, and the session is created
    expect(elapsed).toBeLessThan(500)
    expect(router.liveCount()).toBe(1)
    expect(logs.some((l) => l.includes('name resolver threw') && l.includes('timed out after 50ms'))).toBe(true)
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

  test('a hung history callback times out and degrades to history-not-supported', async () => {
    // given a fetchHistory callback that never resolves (production failure
    // mode: same root cause as the hung name resolver — REST stuck inside
    // the cold-start chain). Without the timeout, prefetchChannelContext
    // would block ensureLive forever even on a known-existing channel.
    const dir = await tempDir()
    const logs: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      fetchHistoryTimeoutMs: 50,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
    })
    router.registerHistory('discord-bot', () => new Promise(() => {}))

    // when fetchHistory is invoked
    const start = Date.now()
    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })
    const elapsed = Date.now() - start

    // then it returns the not-supported degraded result and logs the timeout
    expect(elapsed).toBeLessThan(500)
    expect(result.ok).toBe(false)
    expect(logs.some((l) => l.includes('history fetch threw') && l.includes('timed out after 50ms'))).toBe(true)
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
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
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

  test('observe-only session is not evicted on the next GC tick after creation', async () => {
    // given: a session created by an observe-only inbound (suppressed by
    // mentionsOthers, no engage signal). lastInboundAt is initialized to
    // `now()` at creation (not 0) so a freshly created observe-only
    // session gets a full SESSION_IDLE_MS window before GC, instead of
    // being immediately evicted with a `Date.now() - 0` (~56yr) reading.
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    await router.route(
      inbound({
        isBotMention: false,
        mentionsOthers: true, // suppressor → observe
        text: 'hey @someone-else look at this',
      }),
    )
    expect(router.liveCount()).toBe(1)

    // when: GC runs at the next tick (well within SESSION_IDLE_MS)
    nowRef.value = 1000 + SESSION_GC_INTERVAL_MS
    await router.__testing!.runIdleGc!()

    // then: session is preserved
    expect(router.liveCount()).toBe(1)
  })

  test('observe-only session DOES evict after SESSION_IDLE_MS (passive observation does not keep it warm forever)', async () => {
    // given: an observe-only session
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    await router.route(
      inbound({
        isBotMention: false,
        mentionsOthers: true, // suppressor → observe
        text: 'hey @someone-else look at this',
      }),
    )
    expect(router.liveCount()).toBe(1)

    // when: more passive observation arrives but never engages, then time
    // advances past the threshold from session CREATION (not from last
    // observation) — observe deliberately does not bump lastInboundAt
    nowRef.value = 1000 + 5 * 60_000
    await router.route(
      inbound({
        externalMessageId: 'm2',
        isBotMention: false,
        mentionsOthers: true,
        text: 'still chatting with someone else',
      }),
    )
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: session is evicted; passive traffic does not pin memory
    expect(router.liveCount()).toBe(0)
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

describe('ChannelRouter channel.respond gate', () => {
  type PermissionTable = Record<string, readonly string[]>

  const buildPermissions = (table: PermissionTable, fallback: readonly string[] = []): PermissionService => ({
    has: (origin, permission) => {
      if (origin === undefined || origin.kind !== 'channel') return fallback.includes(permission)
      const authorId = origin.lastInboundAuthorId ?? '*'
      const grants = table[authorId] ?? fallback
      return grants.includes(permission)
    },
    resolveRole: () => 'guest',
    describe: () => ({ role: 'guest', permissions: [] }),
    replaceRoles: () => {},
  })

  test('author has channel.respond → routes through normally', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ alice: ['channel.respond'] })
    const { router, sessions } = makeRouter(dir, { permissions })

    await router.route(inbound({ authorId: 'alice' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.prompts).toHaveLength(1)
  })

  test('author lacks channel.respond → inbound dropped, no session created', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const permissions = buildPermissions({ alice: ['channel.respond'] })
    const { router, sessions } = makeRouter(dir, { permissions, logs })

    await router.route(inbound({ authorId: 'stranger', externalMessageId: 'm-stranger' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions).toHaveLength(0)
    expect(router.liveCount()).toBe(0)
    expect(logs.some((l) => l.includes('denied by permissions') && l.includes('author=stranger'))).toBe(true)
  })

  test('denied author + later granted author → only the granted one routes', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ alice: ['channel.respond'] })
    const { router, sessions } = makeRouter(dir, { permissions })

    await router.route(inbound({ authorId: 'stranger', externalMessageId: 'm-stranger' }))
    await new Promise((r) => setTimeout(r, 5))
    expect(sessions).toHaveLength(0)
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'm-alice' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.prompts).toHaveLength(1)
  })

  test('deny-all permissions service drops every inbound', async () => {
    const dir = await tempDir()
    const permissions: PermissionService = {
      has: () => false,
      resolveRole: () => 'guest',
      describe: () => ({ role: 'guest', permissions: [] }),
      replaceRoles: () => {},
    }
    const { router, sessions } = makeRouter(dir, { permissions })

    await router.route(inbound())
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions).toHaveLength(0)
    expect(router.liveCount()).toBe(0)
  })
})

describe('ChannelRouter role-claim bypass', () => {
  type SentMsg = { adapter: string; chat: string; text: string | undefined }

  const denyAllPermissions: PermissionService = {
    has: () => false,
    resolveRole: () => 'guest',
    describe: () => ({ role: 'guest', permissions: [] }),
    replaceRoles: () => {},
  }

  test('DM with claim code → handler is invoked, reply sent, no session created, gate bypassed', async () => {
    const dir = await tempDir()
    const sent: SentMsg[] = []
    let calls = 0
    const claimHandler: ClaimHandler = async (input) => {
      calls++
      expect(input.isDm).toBe(true)
      expect(input.text).toContain('claim-')
      return { kind: 'consumed', reply: 'Welcome owner!' }
    }
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ adapter: msg.adapter, chat: msg.chat, text: msg.text })
      return { ok: true }
    })

    await router.route(inbound({ isDm: true, text: 'here you go: claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(1)
    expect(sent).toEqual([{ adapter: 'discord-bot', chat: 'c1', text: 'Welcome owner!' }])
    expect(sessions).toHaveLength(0)
    expect(router.liveCount()).toBe(0)
  })

  test('non-DM with claim code → handler NOT invoked, falls through to gate (denied)', async () => {
    const dir = await tempDir()
    let calls = 0
    const claimHandler: ClaimHandler = async () => {
      calls++
      return { kind: 'consumed', reply: 'x' }
    }
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })

    await router.route(inbound({ isDm: false, text: 'claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(0)
    expect(sessions).toHaveLength(0)
  })

  test('DM without a claim code → handler NOT invoked, falls through to gate (denied)', async () => {
    const dir = await tempDir()
    let calls = 0
    const claimHandler: ClaimHandler = async () => {
      calls++
      return { kind: 'consumed', reply: 'x' }
    }
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })

    await router.route(inbound({ isDm: true, text: 'hi there' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(0)
    expect(sessions).toHaveLength(0)
  })

  test('handler returns fallthrough → message proceeds to normal gate (denied here)', async () => {
    const dir = await tempDir()
    const claimHandler: ClaimHandler = async () => ({ kind: 'fallthrough' })
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })

    await router.route(inbound({ isDm: true, text: 'claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions).toHaveLength(0)
  })

  test('handler returns fail → reply sent, no session created', async () => {
    const dir = await tempDir()
    const sent: SentMsg[] = []
    const claimHandler: ClaimHandler = async () => ({
      kind: 'fail',
      reply: 'This claim has expired. Run typeclaw role claim again.',
    })
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ adapter: msg.adapter, chat: msg.chat, text: msg.text })
      return { ok: true }
    })

    await router.route(inbound({ isDm: true, text: 'claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('expired')
    expect(sessions).toHaveLength(0)
  })

  test('no claimHandler registered → claim DMs are dropped by the channel.respond gate', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, { permissions: denyAllPermissions })

    await router.route(inbound({ isDm: true, text: 'claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions).toHaveLength(0)
  })
})
