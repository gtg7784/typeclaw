import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  PluginContext,
  PluginExports,
  PluginLogger,
  SessionEndEvent,
  SessionIdleEvent,
  SessionPromptEvent,
} from '@/plugin'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import memoryPlugin from './index'

type SpawnCall = { name: string; payload: unknown }

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
  options: { logger?: PluginLogger } = {},
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
    logger: options.logger ?? createPluginLogger('memory'),
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

  test('registers the dreaming cron job with the default schedule when dreaming is not configured', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 5000 })
    expect(exports.cronJobs?.dreaming?.schedule).toBe('0 4 * * *')
  })

  test('default config injects an idleMs of 10 seconds and a default dreaming schedule', async () => {
    const { exports: noDream } = await bootMemoryPlugin(agentDir, {})
    expect(noDream.cronJobs?.dreaming?.schedule).toBe('0 4 * * *')

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

describe('bufferBytes config', () => {
  test('defaults to 100_000 when omitted', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as { bufferBytes: number }).bufferBytes).toBe(100_000)
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

describe('lifecycle logging', () => {
  test('logs `memory-logger spawn` with reason=idle when the debounce timer fires', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 1000 }, { logger })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }

    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger })
    await new Promise((r) => setTimeout(r, 1100))

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
