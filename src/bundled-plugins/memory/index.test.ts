import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as FakeTimers from '@sinonjs/fake-timers'

type Clock = FakeTimers.Clock

import { noopPermissionService } from '@/permissions'
import type {
  PluginContext,
  PluginExports,
  PluginLogger,
  SessionEndEvent,
  SessionIdleEvent,
  SessionPromptEvent,
} from '@/plugin'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import { renderShard } from './frontmatter'
import memoryPlugin from './index'
import { topicShardPath, topicsDir } from './paths'

// Fake timers replace ~10s of real setTimeout waits used to exercise the idle
// debouncer and spawn-timeout race. Date is included in `toFake` so the
// per-agent spawn serialization tests' `Date.now()` non-overlap assertions
// observe the fake clock instead of wall-clock skew.
let clock: Clock | null = null

function installFakeClock(): void {
  clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
}

async function uninstallFakeClock(): Promise<void> {
  // Drain any in-flight spawn-chain microtasks AND advance any leftover fake
  // timers (e.g. raceSpawn's spawnTimeoutMs timer that the plugin clears in a
  // `finally` block) so they settle before the clock is uninstalled. Without
  // this, a pending fake-timer outlives the install and resumes against real
  // time in the next test, intermittently corrupting per-test assertions.
  if (clock) {
    await clock.runAllAsync()
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
    clock.uninstall()
    clock = null
  }
}

async function tickMs(ms: number): Promise<void> {
  if (!clock) throw new Error('clock not installed; call installFakeClock() in beforeEach')
  // The fire chain awaits real fs.stat (libuv) AND faked setTimeout chained
  // AFTER it (e.g. mock spawnSubagent's spawnDelayMs). One big tickAsync(ms)
  // fires only the setTimeouts scheduled BEFORE the first libuv yield — every
  // subsequent chain link's setTimeout is registered later, after a real
  // event-loop turn settles its predecessor's fs.stat. So we interleave:
  // advance some fake time, yield to libuv, advance more, yield again.
  let remaining = ms
  while (remaining > 0) {
    const step = Math.min(remaining, 25)
    await clock.tickAsync(step)
    remaining -= step
    for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r))
  }
  for (let j = 0; j < 30; j++) await new Promise((r) => setImmediate(r))
}

// Wait for a condition that depends on the spawn chain settling. Use this when
// asserting on captured side effects (`spawned`, `logs.info`) after tickMs,
// since libuv-and-faked-setTimeout interleavings can leave the final chain
// link's microtasks pending past the last drain cycle. The poll uses real
// setImmediate (libuv) not the fake clock.
async function waitFor(predicate: () => boolean, label: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`waitFor(${label}) exhausted ${attempts} attempts without predicate becoming true`)
}

type SpawnCall = { name: string; payload: unknown; options: unknown; startedAt: number; finishedAt: number }

type CapturedLogs = { info: string[]; warn: string[]; error: string[] }

function makeCapturingLogger(): { logger: PluginLogger; logs: CapturedLogs } {
  const logs: CapturedLogs = { info: [], warn: [], error: [] }
  const logger: PluginLogger = {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
  }
  return { logger, logs }
}

async function bootMemoryPlugin(
  agentDir: string,
  rawConfig: unknown,
  options: { logger?: PluginLogger; spawnDelayMs?: number } = {},
): Promise<{
  exports: PluginExports
  spawned: SpawnCall[]
  ctx: PluginContext<unknown>
}> {
  const spawned: SpawnCall[] = []
  const parsed = memoryPlugin.configSchema!.safeParse(rawConfig)
  if (!parsed.success) throw new Error(`config invalid: ${parsed.error.message}`)
  const spawnDelayMs = options.spawnDelayMs ?? 0
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger: options.logger ?? createPluginLogger('memory'),
    permissions: noopPermissionService,
    spawnSubagent: async (name, payload, spawnOptions) => {
      const startedAt = Date.now()
      if (spawnDelayMs > 0) await new Promise((r) => setTimeout(r, spawnDelayMs))
      const finishedAt = Date.now()
      spawned.push({ name, payload, options: spawnOptions, startedAt, finishedAt })
    },
    isBooted: () => true,
  })
  const exports = await memoryPlugin.plugin(ctx)
  return { exports, spawned, ctx }
}

let agentDir: string

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-05-16' }, body),
  )
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-plugin-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('memory plugin shape', () => {
  test('awaits migration before returning hooks', async () => {
    const memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, '2026-05-15.md'),
      '<!-- fragment source=sess-1 entry=ent-1 -->\n## Test Topic\nTest body\n',
      'utf8',
    )

    const { exports } = await bootMemoryPlugin(agentDir, {})

    expect(existsSync(join(memoryDir, '2026-05-15.jsonl'))).toBe(true)
    expect(existsSync(join(memoryDir, '2026-05-15.md'))).toBe(false)
    expect(exports.hooks).toBeDefined()
    expect(exports.subagents).toBeDefined()
  })

  test('rejects plugin boot when migration fails', async () => {
    const memoryDir = join(agentDir, 'memory')
    await mkdir(join(memoryDir, '2026-05-15.md'), { recursive: true })

    await expect(bootMemoryPlugin(agentDir, {})).rejects.toThrow()
  })

  test('exposes memory subagents and memory_search tool', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    expect(Object.keys(exports.subagents ?? {})).toEqual(
      expect.arrayContaining(['memory-logger', 'dreaming', 'memory-retrieval']),
    )
    expect(exports.tools?.memory_search).toBeDefined()
  })

  test('registers a dreaming cron job with the configured schedule', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { dreaming: { schedule: '*/5 * * * *' } })
    const cron = exports.cronJobs?.dreaming
    expect(cron).toBeDefined()
    expect(cron!.schedule).toBe('*/5 * * * *')
    expect(cron!.kind).toBe('prompt')
    if (cron!.kind === 'prompt') {
      expect(cron!.subagent).toBe('dreaming')
      expect(cron!.payload).toEqual({ agentDir })
    }
  })

  test('accepts five-field dreaming schedules with extra whitespace', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { dreaming: { schedule: '  */5   * * * *  ' } })

    expect(exports.cronJobs?.dreaming?.schedule).toBe('  */5   * * * *  ')
  })

  test('registers the dreaming cron job with the default schedule when dreaming is not configured', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 5000 })
    expect(exports.cronJobs?.dreaming?.schedule).toBe('*/30 * * * *')
  })

  test('default config injects an idleMs of 60 seconds and a default dreaming schedule', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as { idleMs: number }).idleMs).toBe(60_000)
    }

    const { exports: noDream } = await bootMemoryPlugin(agentDir, {})
    expect(noDream.cronJobs?.dreaming?.schedule).toBe('*/30 * * * *')

    const { exports: withDream } = await bootMemoryPlugin(agentDir, { dreaming: {} })
    expect(withDream.cronJobs?.dreaming?.schedule).toBe('*/30 * * * *')
  })

  test('rejects invalid cron expression in dreaming.schedule', async () => {
    await expect(bootMemoryPlugin(agentDir, { dreaming: { schedule: 'not a cron' } })).rejects.toThrow(/cron/i)
  })

  test('rejects second-level dreaming schedules to prevent tight cron loops', async () => {
    await expect(bootMemoryPlugin(agentDir, { dreaming: { schedule: '* * * * * *' } })).rejects.toThrow(/five-field/i)
  })

  test('rejects idleMs below the 1000ms minimum (lower bound prevents memory-logger thrash)', async () => {
    await expect(bootMemoryPlugin(agentDir, { idleMs: 500 })).rejects.toThrow()
  })
})

describe('session.prompt hook', () => {
  test('spawns memory-retrieval when the injection plan is index mode', async () => {
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { injectionBudgetBytes: 4096 })
    const origin: SessionPromptEvent['origin'] = { kind: 'tui', sessionId: 'ses_parent' }

    await exports.hooks!['session.prompt']!(
      { sessionId: 'ses_parent', agentDir, prompt: 'what do I know?', origin },
      {
        agentDir,
        pluginName: 'memory',
        logger: createPluginLogger('m'),
      },
    )

    await waitFor(() => spawned.length >= 1, 'memory-retrieval spawn settles')

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-retrieval')
    expect(spawned[0]!.payload).toEqual({
      parentSessionId: 'ses_parent',
      agentDir,
      recentPrompt: 'what do I know?',
      cacheFilePath: join(agentDir, 'memory', '.retrieval-cache', 'ses_parent.md'),
      origin,
    })
    expect(spawned[0]!.options).toEqual({ parentSessionId: 'ses_parent', spawnedByOrigin: origin })
  })

  test('does not block on a slow memory-retrieval spawn (cold-start guard)', async () => {
    // given a memory-retrieval spawn that takes 10s and a session.prompt hook
    // invoked during cold-start. ensureLive in src/channels/router.ts caps the
    // whole createForChannel chain at 30s; if the hook awaited the spawn,
    // memory-retrieval's LLM call would consume the full ensureLive budget
    // and time out on Discord/Slack first-message-after-stale-rollover.
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const { exports, spawned } = await bootMemoryPlugin(
      agentDir,
      { injectionBudgetBytes: 4096 },
      { spawnDelayMs: 10_000 },
    )

    // when session.prompt fires
    const start = Date.now()
    await exports.hooks!['session.prompt']!(
      { sessionId: 'ses_cold_start', agentDir, prompt: 'first message after restart', origin: undefined },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('m') },
    )
    const elapsed = Date.now() - start

    // then the hook returned promptly (well under the slow-spawn duration)
    // and the spawn was kicked off in the background
    expect(elapsed).toBeLessThan(500)
    expect(spawned).toHaveLength(0)
  })

  test('detached spawn rejection is reported via plugin logger, not unhandled', async () => {
    // given a spawnSubagent that rejects synchronously
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes: 4096 })
    if (!parsed.success) throw new Error(parsed.error.message)
    const { logger, logs } = makeCapturingLogger()
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger,
      permissions: noopPermissionService,
      spawnSubagent: async () => {
        throw new Error('spawn rejected for test')
      },
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)

    // when session.prompt fires
    await exports.hooks!['session.prompt']!(
      { sessionId: 'ses_fail', agentDir, prompt: 'q?', origin: undefined },
      { agentDir, pluginName: 'memory', logger },
    )

    await waitFor(
      () => logs.error.some((m) => m.includes('memory-retrieval spawn failed')),
      'detached spawn rejection routed to logger',
    )

    // then the plugin logger received the failure with attribution
    const errorLine = logs.error.find((m) => m.includes('memory-retrieval spawn failed'))
    expect(errorLine).toMatch(/spawn rejected for test/)
  })

  test('does not spawn memory-retrieval when the injection plan is direct mode', async () => {
    await writeTopic(agentDir, 'small-a', 'Small A', 'small body')
    const { exports, spawned } = await bootMemoryPlugin(agentDir, {})

    await exports.hooks!['session.prompt']!(
      { sessionId: 'ses_direct', agentDir, prompt: 'small?' },
      {
        agentDir,
        pluginName: 'memory',
        logger: createPluginLogger('m'),
      },
    )

    expect(spawned).toHaveLength(0)
  })

  test('does not recurse for subagent-origin prompt events', async () => {
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { injectionBudgetBytes: 4096 })

    await exports.hooks!['session.prompt']!(
      {
        sessionId: 'ses_subagent',
        agentDir,
        prompt: 'subagent prompt',
        origin: { kind: 'subagent', subagent: 'memory-retrieval', parentSessionId: 'ses_parent' },
      },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('m') },
    )

    expect(spawned).toHaveLength(0)
  })
})

describe('session.idle hook (debouncer)', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('does NOT spawn memory-logger synchronously on idle', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })
    expect(spawned).toHaveLength(0)
  })

  test('spawns memory-logger after idleMs elapses with no further idle events', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })

    await tickMs(1100)
    await waitFor(() => spawned.length >= 1, 'spawned.length>=1')

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
    expect(spawned[0]!.payload).toEqual({
      parentSessionId: 'ses_a',
      parentTranscriptPath: '/tmp/t.jsonl',
      agentDir,
    })
  })

  test('passes conversation origin to memory-logger payload', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const origin: SessionIdleEvent['origin'] = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T123',
      workspaceName: 'Acme',
      chat: 'C456',
      chatName: 'infra',
      thread: '171234.0001',
      lastInboundAuthorId: 'U1',
      participants: [
        {
          authorId: 'U1',
          authorName: 'Neo',
          firstMessageAt: 1000,
          lastMessageAt: 2000,
          messageCount: 2,
        },
      ],
    }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0, origin }

    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })
    await tickMs(1100)
    await waitFor(() => spawned.length >= 1, 'spawned.length>=1')

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.payload).toEqual({
      parentSessionId: 'ses_a',
      parentTranscriptPath: '/tmp/t.jsonl',
      agentDir,
      origin,
    })
  })

  test('rapid idle events debounce: only one spawn after the LAST idle + idleMs', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(400)
    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(400)
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)

    await tickMs(1200)
    await waitFor(() => spawned.length >= 1, 'spawned.length>=1')

    expect(spawned).toHaveLength(1)
  })

  test('different sessionIds get independent timers', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 }, ctx)

    await tickMs(1200)
    await waitFor(() => spawned.length >= 2, 'spawned.length>=2')

    expect(spawned).toHaveLength(2)
    const sessions = spawned.map((c) => (c.payload as { parentSessionId: string }).parentSessionId).sort()
    expect(sessions).toEqual(['ses_a', 'ses_b'])
  })

  test('does NOT spawn when parentTranscriptPath is undefined (e.g. no persisted transcript)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: undefined, idleMs: 0 }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })

    await tickMs(1200)

    expect(spawned).toHaveLength(0)
  })

  test('does NOT spawn for subagent-origin idle events (prevents memory-logger self-recursion)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const origin: SessionIdleEvent['origin'] = {
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'ses_parent',
    }
    const event: SessionIdleEvent = {
      sessionId: 'ses_subagent',
      parentTranscriptPath: '/tmp/subagent-transcript.jsonl',
      idleMs: 0,
      origin,
    }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })

    await tickMs(1200)

    expect(spawned).toHaveLength(0)
  })
})

describe('session.end hook', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('cancels the idle timer and spawns memory-logger immediately on close', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
  })

  test('deletes the retrieval cache file on close', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    const cacheFilePath = join(agentDir, 'memory', '.retrieval-cache', 'ses_cache.md')
    await mkdir(join(agentDir, 'memory', '.retrieval-cache'), { recursive: true })
    await writeFile(cacheFilePath, 'retrieved context', 'utf8')

    await exports.hooks!['session.end']!({ sessionId: 'ses_cache' } as SessionEndEvent, {
      agentDir,
      pluginName: 'memory',
      logger: createPluginLogger('m'),
    })

    expect(existsSync(cacheFilePath)).toBe(false)
  })

  test('logs a warning when retrieval cache cleanup fails for a non-ENOENT error', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 }, { logger })
    const cacheFilePath = join(agentDir, 'memory', '.retrieval-cache', 'ses_cache.md')
    await mkdir(cacheFilePath, { recursive: true })

    await exports.hooks!['session.end']!({ sessionId: 'ses_cache' } as SessionEndEvent, {
      agentDir,
      pluginName: 'memory',
      logger,
    })

    expect(logs.warn.some((m) => m.includes('failed to clean retrieval cache'))).toBe(true)
  })

  test('on close without a prior idle event, does NOT spawn (no transcript path is known)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    await exports.hooks!['session.end']!({ sessionId: 'ses_unknown' } as SessionEndEvent, {
      agentDir,
      pluginName: 'memory',
      logger: createPluginLogger('m'),
    })
    expect(spawned).toHaveLength(0)
  })

  test('does NOT spawn for subagent-origin end events (prevents memory-logger self-recursion)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.end']!(
      {
        sessionId: 'ses_subagent',
        origin: { kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'ses_parent' },
      } as SessionEndEvent,
      ctx,
    )

    expect(spawned).toHaveLength(0)
  })

  test('after close, no further pending timer fires', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    await tickMs(1200)

    expect(spawned).toHaveLength(1)
  })
})

describe('bufferBytes config', () => {
  test('defaults to 500_000 when omitted', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as { bufferBytes: number }).bufferBytes).toBe(500_000)
    }
  })

  test('accepts 0 to disable', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({ bufferBytes: 0 })
    expect(parsed.success).toBe(true)
  })

  test('rejects values between 1 and 9_999 (would thrash the subagent)', async () => {
    await expect(bootMemoryPlugin(agentDir, { bufferBytes: 5000 })).rejects.toThrow()
  })

  test('accepts values >= 10_000', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({ bufferBytes: 10_000 })
    expect(parsed.success).toBe(true)
  })

  test('rejects negative values', async () => {
    await expect(bootMemoryPlugin(agentDir, { bufferBytes: -1 })).rejects.toThrow()
  })
})

describe('session.idle hook (buffer-bytes ceiling)', () => {
  test('does NOT fire on the first idle event (initializes baseline)', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'x'.repeat(50_000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }, ctx)

    expect(spawned).toHaveLength(0)
  })

  test('fires synchronously when growth since last run reaches bufferBytes', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'x'.repeat(1000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: first idle initializes baseline at 1000 bytes
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(0)

    // when: transcript grows by 10_000 bytes and another idle fires
    await appendFile(transcript, 'y'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)

    // then: memory-logger spawns synchronously, before idleMs elapses
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
  })

  test('does NOT fire when growth is below bufferBytes', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'x'.repeat(1000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'y'.repeat(9_999))
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)
  })

  test('resets baseline after spawn so next ceiling requires another bufferBytes of growth', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, '')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: baseline at 0 bytes
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(0)

    // when: 10_000 bytes appended → first trip
    await appendFile(transcript, 'a'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(1)

    // and: only 5_000 more bytes appended → no second trip
    await appendFile(transcript, 'b'.repeat(5_000))
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(1)

    // and: another 5_000 bytes (10_000 since last spawn) → second trip
    await appendFile(transcript, 'c'.repeat(5_000))
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(2)
  })

  test('disabled when bufferBytes is 0 (idle-only legacy behavior)', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'x'.repeat(1000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 0 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'y'.repeat(1_000_000))
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)
  })

  test('fail-opens when transcript file does not exist (no spawn, no crash)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = {
      sessionId: 'ses_a',
      parentTranscriptPath: join(agentDir, 'does-not-exist.jsonl'),
      idleMs: 0,
    }

    await exports.hooks!['session.idle']!(event, ctx)
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)
  })

  test('different sessions track buffers independently', async () => {
    const transcriptA = join(agentDir, 'a.jsonl')
    const transcriptB = join(agentDir, 'b.jsonl')
    await writeFile(transcriptA, '')
    await writeFile(transcriptB, '')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    // given: baselines at 0 for both
    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: transcriptA, idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: transcriptB, idleMs: 0 }, ctx)

    // when: A grows by 10_000 but B does not
    await appendFile(transcriptA, 'a'.repeat(10_000))
    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: transcriptA, idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: transcriptB, idleMs: 0 }, ctx)

    // then: only A's session triggered a spawn
    expect(spawned).toHaveLength(1)
    expect((spawned[0]!.payload as { parentSessionId: string }).parentSessionId).toBe('ses_a')
  })
})

describe('per-agent spawn serialization', () => {
  // Real time used here. These tests assert non-overlap via Date.now() inside
  // the mock spawnSubagent (which captures startedAt / finishedAt). Total real
  // wall cost is ~200ms across the three tests — much cheaper than wiring fake
  // timers around the libuv-and-faked-setTimeout interleaving these chains
  // need. Re-evaluate if spawnDelayMs grows significantly.

  // Two concurrent channel sessions must never call spawnSubagent in parallel —
  // the subagent consumer keys memory-logger by agentDir and would silently drop
  // a colliding fire. The plugin owns this serialization via a chained Promise.
  test('back-to-back idle fires for different sessions run sequentially, not in parallel', async () => {
    const { exports, spawned } = await bootMemoryPlugin(
      agentDir,
      { idleMs: 60_000, bufferBytes: 0 },
      { spawnDelayMs: 50 },
    )
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    // given: two sessions trip the buffer ceiling at the same moment via session.end
    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 }, ctx)

    // when: both fire via session.end nearly simultaneously
    await Promise.all([
      exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx),
      exports.hooks!['session.end']!({ sessionId: 'ses_b' } as SessionEndEvent, ctx),
    ])

    // then: both spawned, but the second started AFTER the first finished (no overlap)
    expect(spawned).toHaveLength(2)
    const [first, second] = [...spawned].sort((a, b) => a.startedAt - b.startedAt)
    expect(second!.startedAt).toBeGreaterThanOrEqual(first!.finishedAt)
  })

  test('three back-to-back fires preserve FIFO order', async () => {
    const { exports, spawned } = await bootMemoryPlugin(
      agentDir,
      { idleMs: 60_000, bufferBytes: 0 },
      { spawnDelayMs: 20 },
    )
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_c', parentTranscriptPath: '/tmp/c.jsonl', idleMs: 0 }, ctx)

    await Promise.all([
      exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx),
      exports.hooks!['session.end']!({ sessionId: 'ses_b' } as SessionEndEvent, ctx),
      exports.hooks!['session.end']!({ sessionId: 'ses_c' } as SessionEndEvent, ctx),
    ])

    expect(spawned).toHaveLength(3)
    expect(spawned.map((s) => (s.payload as { parentSessionId: string }).parentSessionId)).toEqual([
      'ses_a',
      'ses_b',
      'ses_c',
    ])
  })

  test('a failing spawn does not break the chain for subsequent fires', async () => {
    const spawned: SpawnCall[] = []
    const parsed = memoryPlugin.configSchema!.safeParse({ idleMs: 60_000, bufferBytes: 0 })
    if (!parsed.success) throw new Error('config invalid')
    let firstCall = true
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger: createPluginLogger('m'),
      permissions: noopPermissionService,
      spawnSubagent: async (name, payload) => {
        const startedAt = Date.now()
        if (firstCall) {
          firstCall = false
          throw new Error('first spawn boom')
        }
        spawned.push({ name, payload, options: undefined, startedAt, finishedAt: Date.now() })
      },
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)
    const hookCtx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!(
      { sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 },
      hookCtx,
    )
    await exports.hooks!['session.idle']!(
      { sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 },
      hookCtx,
    )

    await Promise.all([
      exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, hookCtx),
      exports.hooks!['session.end']!({ sessionId: 'ses_b' } as SessionEndEvent, hookCtx),
    ])

    expect(spawned).toHaveLength(1)
    expect((spawned[0]!.payload as { parentSessionId: string }).parentSessionId).toBe('ses_b')
  })

  test('a hanging spawn does not wedge the chain; subsequent fires recover after the timeout', async () => {
    // given a config where spawnTimeoutMs is short enough to fire in the
    // test window. without the spawn-side timeout, a non-settling
    // spawnSubagent would wedge spawnChain forever and every subsequent
    // session.end would block on the dead chain — silently coalescing all
    // future cron fires per the production failure mode.
    const spawned: SpawnCall[] = []
    const parsed = memoryPlugin.configSchema!.safeParse({
      idleMs: 60_000,
      bufferBytes: 0,
      spawnTimeoutMs: 30,
    })
    if (!parsed.success) throw new Error('config invalid')
    const { logger, logs } = makeCapturingLogger()
    let firstCall = true
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger,
      permissions: noopPermissionService,
      spawnSubagent: async (name, payload) => {
        const startedAt = Date.now()
        if (firstCall) {
          firstCall = false
          await new Promise<void>(() => {})
          return
        }
        spawned.push({ name, payload, options: undefined, startedAt, finishedAt: Date.now() })
      },
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)
    const hookCtx = { agentDir, pluginName: 'memory', logger }

    // when two sessions fire end-to-end while the first spawn hangs forever
    await exports.hooks!['session.idle']!(
      { sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 },
      hookCtx,
    )
    await exports.hooks!['session.idle']!(
      { sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 },
      hookCtx,
    )

    const start = Date.now()
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, hookCtx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_b' } as SessionEndEvent, hookCtx)
    const elapsed = Date.now() - start

    // then the hung spawn timed out within the configured ceiling, the
    // failure was logged with attribution, and the next spawn ran to
    // completion
    expect(elapsed).toBeLessThan(2000)
    expect(spawned).toHaveLength(1)
    expect((spawned[0]!.payload as { parentSessionId: string }).parentSessionId).toBe('ses_b')
    expect(logs.error.some((m) => m.includes('memory-logger spawn failed') && m.includes('timed out after 30ms'))).toBe(
      true,
    )
  })
})

describe('lifecycle logging', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('logs `memory-logger spawn` with reason=idle when the debounce timer fires', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 1000 }, { logger })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }

    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger })
    await tickMs(1100)
    await waitFor(
      () => logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=idle')),
      'memory-logger spawn ses_a reason=idle',
    )

    expect(logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=idle'))).toBe(true)
  })

  test('logs `memory-logger spawn` with reason=session-end when the session closes', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 60_000 }, { logger })
    const ctx = { agentDir, pluginName: 'memory', logger }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    expect(logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=session-end'))).toBe(
      true,
    )
  })

  test('logs `buffer-ceiling trip` and `memory-logger spawn reason=buffer-trip` when the size ceiling fires', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, '')

    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 }, { logger })
    const ctx = { agentDir, pluginName: 'memory', logger }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'x'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)

    expect(logs.info.some((m) => m.includes('buffer-ceiling trip ses_a') && m.includes('bufferBytes=10000'))).toBe(true)
    expect(logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=buffer-trip'))).toBe(
      true,
    )
  })
})

describe('doctor checks', () => {
  test('legacy-md-cleanup: Case A — only .md present → warning with fix.apply', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, '2026-05-15.md'),
      '<!-- fragment source=sess-1 entry=ent-1 -->\n## Test Topic\nTest body\n',
      'utf8',
    )

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('legacy .md daily stream(s) still present')
    expect(result.fix).toBeDefined()
    expect(result.fix!.description).toContain('Re-run migration')
    expect(result.fix!.apply).toBeDefined()

    const fixResult = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(fixResult.summary).toContain('migrated')
    expect(fixResult.changedPaths).toContain('memory/2026-05-15.jsonl')
    expect(existsSync(join(memoryDir, '2026-05-15.md'))).toBe(false)
    expect(existsSync(join(memoryDir, '2026-05-15.jsonl'))).toBe(true)
  })

  test('legacy-md-cleanup: Case B — both .md and .jsonl present → warning, no fix.apply', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, '2026-05-15.md'), 'legacy', 'utf8')
    await writeFile(join(memoryDir, '2026-05-15.jsonl'), '{}\n', 'utf8')

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('Conflicting .md+.jsonl pair')
    expect(result.fix).toBeDefined()
    expect(result.fix!.description).toContain('Manual inspection required')
    expect(result.fix!.apply).toBeUndefined()
  })

  test('legacy-md-cleanup: clean state — only .jsonl files → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, '2026-05-15.jsonl'), '{}\n', 'utf8')

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
  })

  test('legacy-md-cleanup: no memory dir → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
  })

  test('legacy-md-cleanup: un-migrated root MEMORY.md with no topics dir → warning with sharding fix', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    await writeFile(join(agentDir, 'MEMORY.md'), '## Old Topic\nSome body\n', 'utf8')

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('root MEMORY.md present but not sharded')
    expect(result.fix).toBeDefined()
    expect(result.fix!.description).toContain('sharding migration')
    expect(result.fix!.apply).toBeDefined()

    const fixResult = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(fixResult.summary).toContain('sharded')
  })

  test('legacy-md-cleanup: orphaned root MEMORY.md with topics dir → warning with delete fix', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    await mkdir(join(agentDir, 'memory', 'topics'), { recursive: true })
    await writeFile(join(agentDir, 'MEMORY.md'), '## Old Topic\nSome body\n', 'utf8')

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('orphaned root MEMORY.md')
    expect(result.fix).toBeDefined()
    expect(result.fix!.description).toContain('Delete')
    expect(result.fix!.apply).toBeDefined()

    const fixResult = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(fixResult.summary).toContain('deleted')
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
  })

  test('dir-writable: memory/topics/ missing → auto-creates and returns ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['dir-writable']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('created')
    expect(existsSync(join(agentDir, 'memory', 'topics'))).toBe(true)
  })

  test('dir-writable: memory/topics/ already exists → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    await mkdir(join(agentDir, 'memory', 'topics'), { recursive: true })

    const check = exports.doctorChecks?.['dir-writable']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('writable')
  })

  test('daily-stream-current: memory/streams/<today>.jsonl present → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const today = new Date().toISOString().slice(0, 10)
    await mkdir(join(agentDir, 'memory', 'streams'), { recursive: true })
    await writeFile(join(agentDir, 'memory', 'streams', `${today}.jsonl`), '', 'utf8')

    const check = exports.doctorChecks?.['daily-stream-current']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('present')
  })

  test('daily-stream-current: missing → warning with fix that creates file', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['daily-stream-current']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('missing')
    expect(result.fix).toBeDefined()
    expect(result.fix!.apply).toBeDefined()

    const fixResult = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger })
    const today = new Date().toISOString().slice(0, 10)
    expect(fixResult.changedPaths).toContain(join('memory', 'streams', `${today}.jsonl`))
    expect(existsSync(join(agentDir, 'memory', 'streams', `${today}.jsonl`))).toBe(true)
  })

  test('pre-shard-backup-age: no backup → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['pre-shard-backup-age']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('no pre-shard backup present')
  })

  test('pre-shard-backup-age: backup ≤30 days → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const backupPath = join(agentDir, 'memory', 'MEMORY.md.pre-shard.bak')
    await mkdir(join(agentDir, 'memory'), { recursive: true })
    await writeFile(backupPath, 'backup', 'utf8')
    const now = new Date()
    await utimes(backupPath, now, now)

    const check = exports.doctorChecks?.['pre-shard-backup-age']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('under 30-day threshold')
  })

  test('pre-shard-backup-age: backup >30 days → warning with fix that deletes', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const backupPath = join(agentDir, 'memory', 'MEMORY.md.pre-shard.bak')
    await mkdir(join(agentDir, 'memory'), { recursive: true })
    await writeFile(backupPath, 'backup', 'utf8')
    const old = new Date(Date.now() - 31 * 86_400_000)
    await utimes(backupPath, old, old)

    const check = exports.doctorChecks?.['pre-shard-backup-age']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('31 days old')
    expect(result.fix).toBeDefined()
    expect(result.fix!.apply).toBeDefined()

    const fixResult = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(fixResult.summary).toContain('deleted')
    expect(existsSync(backupPath)).toBe(false)
  })
})
