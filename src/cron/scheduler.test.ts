import { describe, expect, test } from 'bun:test'

import { createScheduler, type JobRunner, type SchedulerClock, type SchedulerLogger } from './scheduler'
import type { CronJob } from './schema'

const silentLogger: SchedulerLogger = { info: () => {}, warn: () => {}, error: () => {} }

function createFakeClock(start = new Date('2026-01-01T00:00:00Z').getTime()): SchedulerClock & {
  advance: (ms: number) => Promise<void>
  handleCount: () => number
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
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt)[0]
        if (!due) break
        now = due.fireAt
        due.cancelled = true
        due.cb()
        await new Promise((r) => setImmediate(r))
      }
      now = target
    },
    handleCount: () => Array.from(handles.values()).filter((t) => !t.cancelled).length,
  }
}

type RunnerCall = { kind: 'prompt' | 'exec'; id: string; firedAt: number }

function createRecordingRunner(opts: { runtimeMs?: number; fail?: boolean } = {}): JobRunner & {
  calls: RunnerCall[]
  callsByJob: Map<string, RunnerCall[]>
  completedIds: string[]
  lastPromptText: Map<string, string>
} {
  const calls: RunnerCall[] = []
  const callsByJob = new Map<string, RunnerCall[]>()
  const completedIds: string[] = []
  const lastPromptText = new Map<string, string>()
  const { runtimeMs = 0, fail = false } = opts

  const record = async (kind: 'prompt' | 'exec', id: string, now: number, promptText?: string) => {
    const call: RunnerCall = { kind, id, firedAt: now }
    calls.push(call)
    const existing = callsByJob.get(id) ?? []
    existing.push(call)
    callsByJob.set(id, existing)
    if (promptText !== undefined) lastPromptText.set(id, promptText)
    if (runtimeMs > 0) await new Promise((r) => setTimeout(r, runtimeMs))
    if (fail) throw new Error(`simulated failure for ${id}`)
    completedIds.push(id)
  }

  return {
    calls,
    callsByJob,
    completedIds,
    lastPromptText,
    runPrompt: async (job) => record('prompt', job.id, Date.now(), job.prompt),
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

describe('Scheduler.replaceJobs', () => {
  test('returns a diff describing what changed', () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({
      jobs: [promptJob('keep', '* * * * *'), promptJob('remove', '0 * * * *')],
      runner,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    const diff = scheduler.replaceJobs([
      promptJob('keep', '* * * * *'),
      promptJob('add', '*/5 * * * *'),
      promptJob('remove', '0 * * * *', { prompt: 'changed prompt' }),
    ])

    expect(diff.added.map((j) => j.id)).toEqual(['add'])
    expect(diff.removed.map((j) => j.id)).toEqual([])
    expect(diff.updated.map((j) => j.id)).toEqual(['remove'])
    expect(diff.unchanged.map((j) => j.id)).toEqual(['keep'])

    scheduler.stop()
  })

  test('detects removal when a job id is no longer present', () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({
      jobs: [promptJob('a', '* * * * *'), promptJob('b', '* * * * *')],
      runner,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    const diff = scheduler.replaceJobs([promptJob('a', '* * * * *')])

    expect(diff.removed.map((j) => j.id)).toEqual(['b'])
    expect(diff.unchanged.map((j) => j.id)).toEqual(['a'])

    scheduler.stop()
  })

  test('treats schedule, prompt, command, kind, timezone, and enabled changes as updates', () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({
      jobs: [
        promptJob('p1', '* * * * *'),
        promptJob('p2', '* * * * *', { timezone: 'UTC' }),
        execJob('e1', '0 * * * *'),
      ],
      runner,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    const diff = scheduler.replaceJobs([
      promptJob('p1', '*/2 * * * *'),
      promptJob('p2', '* * * * *', { timezone: 'Asia/Seoul' }),
      execJob('e1', '0 * * * *', { command: ['echo', 'changed'] }),
    ])

    expect(diff.updated.map((j) => j.id).sort()).toEqual(['e1', 'p1', 'p2'])

    scheduler.stop()
  })

  test('newly added jobs start firing on their schedule', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({ jobs: [], runner, clock, logger: silentLogger })
    scheduler.start()

    scheduler.replaceJobs([promptJob('fresh', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    expect(runner.calls.map((c) => c.id)).toEqual(['fresh'])

    scheduler.stop()
  })

  test('removed jobs stop firing immediately (their pending timer is cancelled)', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const scheduler = createScheduler({
      jobs: [promptJob('doomed', '* * * * *'), promptJob('survivor', '* * * * *')],
      runner,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    scheduler.replaceJobs([promptJob('survivor', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    const ids = runner.calls.map((c) => c.id)
    expect(ids).toContain('survivor')
    expect(ids).not.toContain('doomed')

    scheduler.stop()
  })

  test('updated jobs use the new definition for the next fire', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const sched = createScheduler({
      jobs: [promptJob('mut', '* * * * *', { prompt: 'old' })],
      runner,
      clock,
      logger: silentLogger,
    })
    sched.start()

    sched.replaceJobs([promptJob('mut', '* * * * *', { prompt: 'new' })])
    await clock.advance(60 * 1000 + 100)

    expect(runner.calls).toHaveLength(1)
    expect(runner.callsByJob.get('mut')?.[0]?.kind).toBe('prompt')
    expect(runner.lastPromptText.get('mut')).toBe('new')

    sched.stop()
  })

  test('unchanged jobs keep their pending timer (no re-arming)', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const sched = createScheduler({ jobs: [promptJob('keep', '* * * * *')], runner, clock, logger: silentLogger })
    sched.start()

    const beforeHandles = clock.handleCount()
    sched.replaceJobs([promptJob('keep', '* * * * *')])
    const afterHandles = clock.handleCount()

    expect(afterHandles).toBe(beforeHandles)

    await clock.advance(60 * 1000 + 100)
    expect(runner.calls).toHaveLength(1)

    sched.stop()
  })

  test('an in-flight job finishes naturally even if it was removed mid-run', async () => {
    const clock = createFakeClock()
    const resolveBox: { fn: (() => void) | null } = { fn: null }
    const completed: string[] = []
    const runner: JobRunner = {
      runPrompt: (job) =>
        new Promise<void>((resolve) => {
          resolveBox.fn = () => {
            completed.push(job.id)
            resolve()
          }
        }),
      runExec: async () => {},
    }
    const sched = createScheduler({ jobs: [promptJob('long', '* * * * *')], runner, clock, logger: silentLogger })
    sched.start()

    await clock.advance(60 * 1000 + 100)
    expect(resolveBox.fn).not.toBeNull()
    expect(completed).toEqual([])

    sched.replaceJobs([])
    await clock.advance(10 * 60 * 1000)
    expect(completed).toEqual([])

    resolveBox.fn?.()
    await new Promise((r) => setImmediate(r))

    expect(completed).toEqual(['long'])
    await clock.advance(10 * 60 * 1000)
    expect(completed).toEqual(['long'])

    sched.stop()
  })

  test('replaceJobs after stop() does not start anything', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const sched = createScheduler({ jobs: [], runner, clock, logger: silentLogger })
    sched.start()
    sched.stop()

    sched.replaceJobs([promptJob('late', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    expect(runner.calls).toHaveLength(0)
  })

  test('replaceJobs before start() is allowed; jobs go live on start()', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const sched = createScheduler({ jobs: [], runner, clock, logger: silentLogger })

    sched.replaceJobs([promptJob('preset', '* * * * *')])
    await clock.advance(60 * 1000 + 100)
    expect(runner.calls).toHaveLength(0)

    sched.start()
    await clock.advance(60 * 1000 + 100)
    expect(runner.calls.map((c) => c.id)).toEqual(['preset'])

    sched.stop()
  })

  test('disabled-to-enabled transition is treated as an update and starts firing', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const sched = createScheduler({
      jobs: [promptJob('toggle', '* * * * *', { enabled: false })],
      runner,
      clock,
      logger: silentLogger,
    })
    sched.start()
    await clock.advance(5 * 60 * 1000)
    expect(runner.calls).toHaveLength(0)

    sched.replaceJobs([promptJob('toggle', '* * * * *', { enabled: true })])
    await clock.advance(60 * 1000 + 100)

    expect(runner.calls.map((c) => c.id)).toEqual(['toggle'])

    sched.stop()
  })

  test('enabled-to-disabled transition cancels future fires', async () => {
    const clock = createFakeClock()
    const runner = createRecordingRunner()
    const sched = createScheduler({ jobs: [promptJob('toggle', '* * * * *')], runner, clock, logger: silentLogger })
    sched.start()

    sched.replaceJobs([promptJob('toggle', '* * * * *', { enabled: false })])
    await clock.advance(10 * 60 * 1000)

    expect(runner.calls).toHaveLength(0)

    sched.stop()
  })
})
