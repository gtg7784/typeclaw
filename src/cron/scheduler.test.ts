import { describe, expect, test } from 'bun:test'

import { createScheduler, type SchedulerClock, type SchedulerLogger } from './scheduler'
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

type FireRecord = { kind: CronJob['kind']; id: string; firedAt: number }

function createFireRecorder(): {
  fires: FireRecord[]
  firesByJob: Map<string, FireRecord[]>
  promptText: Map<string, string>
  onFire: (job: CronJob) => void
} {
  const fires: FireRecord[] = []
  const firesByJob = new Map<string, FireRecord[]>()
  const promptText = new Map<string, string>()
  return {
    fires,
    firesByJob,
    promptText,
    onFire: (job) => {
      const record: FireRecord = { kind: job.kind, id: job.id, firedAt: Date.now() }
      fires.push(record)
      const existing = firesByJob.get(job.id) ?? []
      existing.push(record)
      firesByJob.set(job.id, existing)
      if (job.kind === 'prompt') promptText.set(job.id, job.prompt)
    },
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
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('hourly', '0 * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    expect(recorder.fires).toHaveLength(1)
    expect(recorder.fires[0]?.kind).toBe('prompt')
    expect(recorder.fires[0]?.id).toBe('hourly')

    scheduler.stop()
  })

  test('fires an exec job by passing the job to onFire', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [execJob('backup', '0 * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    expect(recorder.fires).toEqual([expect.objectContaining({ kind: 'exec', id: 'backup' })])

    scheduler.stop()
  })

  test('fires repeatedly across multiple ticks', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('every-min', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(5 * 60 * 1000 + 100)

    expect(recorder.fires.length).toBeGreaterThanOrEqual(5)

    scheduler.stop()
  })

  test('skips disabled jobs', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('off', '* * * * *', { enabled: false })],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(10 * 60 * 1000)

    expect(recorder.fires).toHaveLength(0)

    scheduler.stop()
  })

  test('scheduler is fire-and-forget: it does not coalesce or wait for execution', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('every-min', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(5 * 60 * 1000 + 100)

    expect(recorder.fires.length).toBe(5)

    scheduler.stop()
  })

  test('stop() prevents future fires', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('j', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 1000 + 100)
    const firesBeforeStop = recorder.fires.length

    scheduler.stop()
    await clock.advance(10 * 60 * 1000)

    expect(recorder.fires.length).toBe(firesBeforeStop)
  })

  test('an onFire that throws synchronously does not crash the scheduler', async () => {
    const clock = createFakeClock()
    let fires = 0
    const scheduler = createScheduler({
      jobs: [promptJob('j', '* * * * *')],
      onFire: () => {
        fires++
        throw new Error('boom')
      },
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(3 * 60 * 1000 + 100)

    expect(fires).toBeGreaterThanOrEqual(2)

    scheduler.stop()
  })

  test('multiple jobs fire independently', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('a', '* * * * *'), execJob('b', '0 * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    const ids = recorder.fires.map((c) => c.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')

    scheduler.stop()
  })

  test('start() is idempotent - double-start does not duplicate timers', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('j', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    scheduler.start()
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires).toHaveLength(1)

    scheduler.stop()
  })

  test('empty job list is a no-op', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({ jobs: [], onFire: recorder.onFire, clock, logger: silentLogger })

    scheduler.start()
    await clock.advance(60 * 60 * 1000)

    expect(recorder.fires).toHaveLength(0)

    scheduler.stop()
  })
})

describe('Scheduler.replaceJobs', () => {
  test('returns a diff describing what changed', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('keep', '* * * * *'), promptJob('remove', '0 * * * *')],
      onFire: recorder.onFire,
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
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('a', '* * * * *'), promptJob('b', '* * * * *')],
      onFire: recorder.onFire,
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
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [
        promptJob('p1', '* * * * *'),
        promptJob('p2', '* * * * *', { timezone: 'UTC' }),
        execJob('e1', '0 * * * *'),
      ],
      onFire: recorder.onFire,
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
    const recorder = createFireRecorder()
    const scheduler = createScheduler({ jobs: [], onFire: recorder.onFire, clock, logger: silentLogger })
    scheduler.start()

    scheduler.replaceJobs([promptJob('fresh', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires.map((c) => c.id)).toEqual(['fresh'])

    scheduler.stop()
  })

  test('removed jobs stop firing immediately (their pending timer is cancelled)', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('doomed', '* * * * *'), promptJob('survivor', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    scheduler.replaceJobs([promptJob('survivor', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    const ids = recorder.fires.map((c) => c.id)
    expect(ids).toContain('survivor')
    expect(ids).not.toContain('doomed')

    scheduler.stop()
  })

  test('updated jobs use the new definition for the next fire', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({
      jobs: [promptJob('mut', '* * * * *', { prompt: 'old' })],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    sched.start()

    sched.replaceJobs([promptJob('mut', '* * * * *', { prompt: 'new' })])
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires).toHaveLength(1)
    expect(recorder.firesByJob.get('mut')?.[0]?.kind).toBe('prompt')
    expect(recorder.promptText.get('mut')).toBe('new')

    sched.stop()
  })

  test('unchanged jobs keep their pending timer (no re-arming)', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({
      jobs: [promptJob('keep', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    sched.start()

    const beforeHandles = clock.handleCount()
    sched.replaceJobs([promptJob('keep', '* * * * *')])
    const afterHandles = clock.handleCount()

    expect(afterHandles).toBe(beforeHandles)

    await clock.advance(60 * 1000 + 100)
    expect(recorder.fires).toHaveLength(1)

    sched.stop()
  })

  test('replaceJobs after stop() does not start anything', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({ jobs: [], onFire: recorder.onFire, clock, logger: silentLogger })
    sched.start()
    sched.stop()

    sched.replaceJobs([promptJob('late', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires).toHaveLength(0)
  })

  test('replaceJobs before start() is allowed; jobs go live on start()', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({ jobs: [], onFire: recorder.onFire, clock, logger: silentLogger })

    sched.replaceJobs([promptJob('preset', '* * * * *')])
    await clock.advance(60 * 1000 + 100)
    expect(recorder.fires).toHaveLength(0)

    sched.start()
    await clock.advance(60 * 1000 + 100)
    expect(recorder.fires.map((c) => c.id)).toEqual(['preset'])

    sched.stop()
  })

  test('disabled-to-enabled transition is treated as an update and starts firing', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({
      jobs: [promptJob('toggle', '* * * * *', { enabled: false })],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    sched.start()
    await clock.advance(5 * 60 * 1000)
    expect(recorder.fires).toHaveLength(0)

    sched.replaceJobs([promptJob('toggle', '* * * * *', { enabled: true })])
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires.map((c) => c.id)).toEqual(['toggle'])

    sched.stop()
  })

  test('enabled-to-disabled transition cancels future fires', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({
      jobs: [promptJob('toggle', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    sched.start()

    sched.replaceJobs([promptJob('toggle', '* * * * *', { enabled: false })])
    await clock.advance(10 * 60 * 1000)

    expect(recorder.fires).toHaveLength(0)

    sched.stop()
  })
})
