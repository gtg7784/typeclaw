import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'

import type { CreateSessionOptions } from '@/agent'
import type { ChannelRouter } from '@/channels'
import type { ReloadRegistry } from '@/reload'
import type { SessionFactory } from '@/sessions'
import type { Stream } from '@/stream'

import { buildChannelSessionFactory } from './channel-session-factory'
import { createPluginRuntime, type PluginRuntime } from './plugin-runtime'

function makeFakeRouter(): ChannelRouter {
  return {} as ChannelRouter
}

function makeFakeStream(): Stream {
  return {} as Stream
}

function makeFakeReloadRegistry(): ReloadRegistry {
  return {} as ReloadRegistry
}

function makeFakeSessionFactory(sessionDir: string): SessionFactory {
  return { sessionDir: () => sessionDir } as SessionFactory
}

function makeEmptyRuntime(): PluginRuntime {
  return createPluginRuntime({
    registry: { tools: [], subagents: [], cronJobs: [], skills: [], skillsDirs: [], doctorChecks: [] } as never,
    hooks: {} as never,
    subagents: { byName: new Map(), all: [] } as never,
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: false,
    loadedPlugins: [],
    materializedSkills: null,
  })
}

function makeRuntimeWithPlugin(): PluginRuntime {
  return createPluginRuntime({
    registry: { tools: [], subagents: [], cronJobs: [], skills: [], skillsDirs: [], doctorChecks: [] } as never,
    hooks: {} as never,
    subagents: { byName: new Map(), all: [] } as never,
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: true,
    loadedPlugins: [{ name: 'memory', version: undefined, source: '<bundled>' }],
    materializedSkills: null,
  })
}

const STUB_SESSION = { dispose: () => {} } as unknown as AgentSession

type Captured = CreateSessionOptions | undefined

describe('buildChannelSessionFactory — production wiring contract', () => {
  test('creates sessions with channelRouter set (the bug this factory fixes)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const router = makeFakeRouter()
    let captured: Captured = undefined
    const fakeCreateSession = async (options?: CreateSessionOptions) => {
      captured = options
      return STUB_SESSION
    }

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: () => router,
      createSession: fakeCreateSession,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
    })

    expect(captured).toBeDefined()
    expect(captured!.channelRouter).toBe(router)
  })

  test('threads stream and reloadRegistry into the session (so reload + stream tools are wired)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const stream = makeFakeStream()
    const reloadRegistry = makeFakeReloadRegistry()
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream,
      reloadRegistry,
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
    })

    expect(captured!.stream).toBe(stream)
    expect(captured!.reloadRegistry).toBe(reloadRegistry)
  })

  test('omits plugin wiring when the runtime has no plugin content (avoids cost of plugin tool injection)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
    })

    expect(captured!.plugins).toBeUndefined()
  })

  test('threads plugin runtime into the session when plugins are present', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const runtime = makeRuntimeWithPlugin()
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: runtime,
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
    })

    expect(captured!.plugins).toBeDefined()
    expect(captured!.plugins!.registry).toBe(runtime.get().registry)
    expect(captured!.plugins!.hooks).toBe(runtime.get().hooks)
    expect(captured!.plugins!.agentDir).toBe(tmp)
  })

  test('passes through the channel origin verbatim so channel_send target matches inbound', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let captured: Captured = undefined
    const origin = {
      kind: 'channel' as const,
      adapter: 'discord-bot' as const,
      workspace: 'guild-123',
      chat: 'channel-456',
      thread: null,
      participants: [{ authorId: 'u1', authorName: 'alice', firstMessageAt: 1, lastMessageAt: 1, messageCount: 1 }],
    }

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: 'guild-123', chat: 'channel-456', thread: null },
      participants: origin.participants,
      origin,
    })

    expect(captured!.origin).toEqual(origin)
  })

  test('reads getChannelRouter lazily so the manager-router construction cycle resolves', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let router: ChannelRouter | null = null
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: () => {
        if (router === null) throw new Error('router not yet bound')
        return router
      },
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
    })

    router = makeFakeRouter()

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
    })

    expect(captured!.channelRouter).toBe(router)
  })

  test('uses sessionFactory.sessionDir() so persisted sessions land where the rest of the runtime expects', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    let capturedSm: SessionManager | null = null

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        capturedSm = options?.sessionManager ?? null
        return STUB_SESSION
      },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
    })

    expect(capturedSm).not.toBeNull()
  })

  test('returns hooks and getTranscriptPath so the channel router can fire session.idle/session.end', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const runtime = makeRuntimeWithPlugin()

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: runtime,
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
    })

    const result = await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
    })

    expect(result.hooks).toBe(runtime.get().hooks)
    expect(typeof result.getTranscriptPath).toBe('function')
    expect(result.getTranscriptPath?.()).toMatch(/sessions\//)
  })

  test('omits hooks when no plugin runtime content (matches existing plugin-omission policy)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
    })

    const result = await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
    })

    expect(result.hooks).toBeUndefined()
  })
})
