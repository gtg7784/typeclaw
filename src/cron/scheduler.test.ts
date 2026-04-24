import { describe, expect, test } from 'bun:test'

import { createScheduler, type JobRunner, type SchedulerClock, type SchedulerLogger } from './scheduler'
import type { CronJob } from './schema'

const silentLogger: SchedulerLogger = { info: () => {}, warn: () => {}, error: () => {} }

function createFakeClock(start = new Date('2026-01-01T00:00:00Z').getTime()): SchedulerClock & {
  advance: (ms: number) => Promise<void>
} {
  let now = start
  const timers: Array<{ fireAt: number; cb: () => void; cancelled: boolean }> = []
  let nextHandle = 1
  const handles = new Map<number, (typeof timers)[number]>()

  return {
    now: () => now,
    setTimeout: (cb, ms) => {
      const timer = { fireAt: now + Math.max(0, ms), cb, cancelled: false }
      const handle = nextHandle++
      timers.push(timer)
      handles.set(handle, timer)
      return handle
    },
    clearTimeout: (handle) => {
      const timer = handles.get(handle)
      if (timer) timer.cancelled = true
    },
    advance: async (ms) => {
      const target = now + ms
      // Fire timers in order; newly-added timers (from inside callbacks) are
      // picked up on subsequent scans.
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt)[0]
        if (!due) break
        now = due.fireAt
        due.cancelled = true
        due.cb()
        // Let any awaited microtasks inside the callback resolve.
        await new Promise((r) => setImmediate(r))
      }
      now = target
    },
  }
}

type RunnerCall = { kind: 'prompt' | 'exec'; id: string; firedAt: number }

function createRecordingRunner(opts: { runtimeMs?: number; fail?: boolean } = {}): JobRunner & {
  calls: RunnerCall[]
} {
  const calls: RunnerCall[] = []
  const { runtimeMs = 0, fail = false } = opts

  const record = async (kind: 'prompt' | 'exec', id: string, now: number) => {
    calls.push({ kind, id, firedAt: now })
    if (runtimeMs > 0) await new Promise((r) => setTimeout(r, runtimeMs))
    if (fail) throw new Error(`simulated failure for ${id}`)
  }

  return {
    calls,
    runPrompt: async (job) => record('prompt', job.id, Date.now()),
    runExec: async (job) => record('exec', job.id, Date.now()),
  }
}

type PromptOverrides = { enabled?: boolean; timezone?: string; prompt?: string }
type ExecOverrides = { enabled?: boolean; timezone?: string; command?: string[] }

const promptJob = (id: string, schedule: string, overrides: PromptOverrides = {}): CronJob => ({
  id,
  schedule,
  kind: 'prompt',
  prompt: overrides.prompt ?? `run ${id}`,
  enabled: overrides.enabled ?? true,
  ...(overrides.timezone !== undefined && { timezone: overrides.timezone }),
})

const execJob = (id: string, schedule: string, overrides: ExecOverrides = {}): CronJob => ({
  id,
  schedule,
  kind: 'exec',
  command: overrides.command ?? ['echo', id],
  enabled: overrides.enabled ?? true,
  ...(overrides.timezone !== undefined && { timezone: overrides.timezone }),
})

describe('createScheduler', () => {
  test('fires a prompt job at its scheduled time', async () => {
    const clock = createFakeClock(new Date('2026-01-01T00:00:00Z').getTime())
    const runner = createRecordingRunner()
    const scheduler = createScheduler({ jobs: [promptJob('hourly', '0 * * * *')], runner, clock, logger: silentLogger })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.kind).toBe('prompt')
    expect(runner.calls[0]?.id).toBe('hourly')

    scheduler.stop()
  })

  test('fires an exec job via runExec', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({ jobs: [execJob('backup', '0 * * * *')], runner, clock, logger: silentLogger })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    expect(runner.calls).toEqual([expect.objectContaining({ kind: 'exec', id: 'backup' })])

    scheduler.stop()
  })

  test('fires repeatedly across multiple ticks', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({
      jobs: [promptJob('every-min', '* * * * *')],
      runner,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(5 * 60 * 1000 + 100)

    expect(runner.calls.length).toBeGreaterThanOrEqual(5)

    scheduler.stop()
  })

  test('skips disabled jobs', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({
      jobs: [promptJob('off', '* * * * *', { enabled: false })],
      runner,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(10 * 60 * 1000)

    expect(runner.calls).toHaveLength(0)

    scheduler.stop()
  })

  test('coalesces overlapping fires: long-running job does not stack pending ticks', async () => {
    const clock = createFakeClock()
    // Job takes 3 minutes to run but is scheduled every minute.
    const runner = createRecordingRunner({ runtimeMs: 3 * 60 * 1000 })
    const scheduler = createScheduler({ jobs: [promptJob('slow', '* * * * *')], runner, clock, logger: silentLogger })

    scheduler.start()
    await clock.advance(10 * 60 * 1000 + 100)

    // Across 10 minutes, a 3-minute job scheduled every minute should fire at
    // most ~3-4 times (not 10). The key guarantee: we do not stack pending
    // runs while one is already executing.
    expect(runner.calls.length).toBeLessThan(10)
    expect(runner.calls.length).toBeGreaterThan(0)

    scheduler.stop()
  })

  test('stop() prevents future fires', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({ jobs: [promptJob('j', '* * * * *')], runner, clock, logger: silentLogger })

    scheduler.start()
    await clock.advance(60 * 1000 + 100)
    const firesBeforeStop = runner.calls.length

    scheduler.stop()
    await clock.advance(10 * 60 * 1000)

    expect(runner.calls.length).toBe(firesBeforeStop)
  })

  test('a failing job does not crash the scheduler; subsequent fires continue', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner({ fail: true })
    const scheduler = createScheduler({ jobs: [promptJob('j', '* * * * *')], runner, clock, logger: silentLogger })

    scheduler.start()
    await clock.advance(3 * 60 * 1000 + 100)

    expect(runner.calls.length).toBeGreaterThanOrEqual(2)

    scheduler.stop()
  })

  test('multiple jobs fire independently', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({
      jobs: [promptJob('a', '* * * * *'), execJob('b', '0 * * * *')],
      runner,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    const ids = runner.calls.map((c) => c.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')

    scheduler.stop()
  })

  test('start() is idempotent - double-start does not duplicate timers', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({ jobs: [promptJob('j', '* * * * *')], runner, clock, logger: silentLogger })

    scheduler.start()
    scheduler.start()
    await clock.advance(60 * 1000 + 100)

    expect(runner.calls).toHaveLength(1)

    scheduler.stop()
  })

  test('empty job list is a no-op', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({ jobs: [], runner, clock, logger: silentLogger })

    scheduler.start()
    await clock.advance(60 * 60 * 1000)

    expect(runner.calls).toHaveLength(0)

    scheduler.stop()
  })
})
