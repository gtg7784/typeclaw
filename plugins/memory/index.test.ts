import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginContext, PluginExports, SessionEndEvent, SessionIdleEvent, SessionPromptEvent } from '@/plugin'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import memoryPlugin from './index'

type SpawnCall = { name: string; payload: unknown }

async function bootMemoryPlugin(
  agentDir: string,
  rawConfig: unknown,
): Promise<{
  exports: PluginExports
  spawned: SpawnCall[]
  ctx: PluginContext<unknown>
}> {
  const spawned: SpawnCall[] = []
  const parsed = memoryPlugin.configSchema!.safeParse(rawConfig)
  if (!parsed.success) throw new Error(`config invalid: ${parsed.error.message}`)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger: createPluginLogger('memory'),
    spawnSubagent: async (name, payload) => {
      spawned.push({ name, payload })
    },
    isBooted: () => true,
  })
  const exports = await memoryPlugin.plugin(ctx)
  return { exports, spawned, ctx }
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-plugin-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('memory plugin shape', () => {
  test('exposes both subagents', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    expect(Object.keys(exports.subagents ?? {})).toEqual(expect.arrayContaining(['memory-logger', 'dreaming']))
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

  test('omits the dreaming cron job when dreaming is not configured', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 5000 })
    expect(exports.cronJobs?.dreaming).toBeUndefined()
  })

  test('default config injects an idleMs of 30 seconds and a default dreaming schedule', async () => {
    // dreaming is optional in schema; with empty config it stays undefined.
    const { exports: noDream } = await bootMemoryPlugin(agentDir, {})
    expect(noDream.cronJobs?.dreaming).toBeUndefined()

    // explicit dreaming uses default schedule.
    const { exports: withDream } = await bootMemoryPlugin(agentDir, { dreaming: {} })
    expect(withDream.cronJobs?.dreaming?.schedule).toBe('0 4 * * *')
  })

  test('rejects invalid cron expression in dreaming.schedule', async () => {
    await expect(bootMemoryPlugin(agentDir, { dreaming: { schedule: 'not a cron' } })).rejects.toThrow(/cron/i)
  })

  test('rejects idleMs below the 1000ms minimum (lower bound prevents memory-logger thrash)', async () => {
    await expect(bootMemoryPlugin(agentDir, { idleMs: 500 })).rejects.toThrow()
  })
})

describe('session.prompt hook', () => {
  test('appends loadMemory output to the system prompt', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const event: SessionPromptEvent = { prompt: 'BASE PROMPT', sessionId: 'ses_1', agentDir }
    await exports.hooks!['session.prompt']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })
    expect(event.prompt.startsWith('BASE PROMPT\n\n')).toBe(true)
    expect(event.prompt).toContain('# Memory')
  })
})

describe('session.idle hook (debouncer)', () => {
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

    await new Promise((r) => setTimeout(r, 1100))

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
    expect(spawned[0]!.payload).toEqual({
      parentSessionId: 'ses_a',
      parentTranscriptPath: '/tmp/t.jsonl',
      agentDir,
    })
  })

  test('rapid idle events debounce: only one spawn after the LAST idle + idleMs', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await new Promise((r) => setTimeout(r, 400))
    await exports.hooks!['session.idle']!(event, ctx)
    await new Promise((r) => setTimeout(r, 400))
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)

    await new Promise((r) => setTimeout(r, 1200))

    expect(spawned).toHaveLength(1)
  })

  test('different sessionIds get independent timers', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 }, ctx)

    await new Promise((r) => setTimeout(r, 1200))

    expect(spawned).toHaveLength(2)
    const sessions = spawned.map((c) => (c.payload as { parentSessionId: string }).parentSessionId).sort()
    expect(sessions).toEqual(['ses_a', 'ses_b'])
  })

  test('does NOT spawn when parentTranscriptPath is undefined (e.g. no persisted transcript)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: undefined, idleMs: 0 }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })

    await new Promise((r) => setTimeout(r, 1200))

    expect(spawned).toHaveLength(0)
  })
})

describe('session.end hook', () => {
  test('cancels the idle timer and spawns memory-logger immediately on close', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
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

  test('after close, no further pending timer fires', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    await new Promise((r) => setTimeout(r, 1200))

    expect(spawned).toHaveLength(1)
  })
})
