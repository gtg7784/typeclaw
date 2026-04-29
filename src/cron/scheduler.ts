import { CronExpressionParser } from 'cron-parser'

import type { CronJob } from './schema'

export type SchedulerClock = {
  now: () => number
  setTimeout: (cb: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
}

export type SchedulerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateSchedulerOptions = {
  jobs: CronJob[]
  onFire: (job: CronJob) => void
  clock?: SchedulerClock
  logger?: SchedulerLogger
}

export type JobDiff = {
  added: CronJob[]
  removed: CronJob[]
  updated: CronJob[]
  unchanged: CronJob[]
}

export type Scheduler = {
  start: () => void
  stop: () => void
  replaceJobs: (jobs: CronJob[]) => JobDiff
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
}

const consoleLogger: SchedulerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createScheduler({
  jobs,
  onFire,
  clock = realClock,
  logger = consoleLogger,
}: CreateSchedulerOptions): Scheduler {
  const registry = new Map<string, CronJob>()
  for (const job of jobs) registry.set(job.id, job)

  const handles = new Map<string, number>()
  let started = false

  function currentEnabled(id: string): CronJob | null {
    const job = registry.get(id)
    if (!job || !job.enabled) return null
    return job
  }

  function scheduleNext(id: string): void {
    if (!started) return
    const job = currentEnabled(id)
    if (!job) return

    const nextFire = computeNextFire(job, clock.now())
    if (nextFire === null) return

    cancel(id)

    const delay = Math.max(0, nextFire - clock.now())
    const handle = clock.setTimeout(() => {
      handles.delete(id)
      if (!started) return
      const live = currentEnabled(id)
      if (!live) return
      fire(live)
      scheduleNext(id)
    }, delay)
    handles.set(id, handle)
  }

  function fire(job: CronJob): void {
    logger.info(`[cron] firing ${job.kind} ${job.id}`)
    try {
      onFire(job)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[cron] ${job.id} onFire threw synchronously: ${message}`)
    }
  }

  function cancel(id: string): void {
    const handle = handles.get(id)
    if (handle === undefined) return
    clock.clearTimeout(handle)
    handles.delete(id)
  }

  function diff(next: CronJob[]): JobDiff {
    const added: CronJob[] = []
    const removed: CronJob[] = []
    const updated: CronJob[] = []
    const unchanged: CronJob[] = []

    const nextById = new Map<string, CronJob>()
    for (const job of next) nextById.set(job.id, job)

    for (const [id, before] of registry) {
      const after = nextById.get(id)
      if (!after) {
        removed.push(before)
        continue
      }
      if (jobFingerprint(before) === jobFingerprint(after)) {
        unchanged.push(after)
      } else {
        updated.push(after)
      }
    }
    for (const [id, after] of nextById) {
      if (!registry.has(id)) added.push(after)
    }

    return { added, removed, updated, unchanged }
  }

  return {
    start() {
      if (started) return
      started = true
      for (const id of registry.keys()) scheduleNext(id)
    },
    stop() {
      started = false
      for (const handle of handles.values()) clock.clearTimeout(handle)
      handles.clear()
    },
    replaceJobs(next) {
      const result = diff(next)

      const newRegistry = new Map<string, CronJob>()
      for (const job of next) newRegistry.set(job.id, job)
      registry.clear()
      for (const [id, job] of newRegistry) registry.set(id, job)

      for (const job of result.removed) cancel(job.id)
      for (const job of result.updated) {
        cancel(job.id)
        scheduleNext(job.id)
      }
      for (const job of result.added) scheduleNext(job.id)

      return result
    },
  }
}

function jobFingerprint(job: CronJob): string {
  return JSON.stringify({
    schedule: job.schedule,
    enabled: job.enabled,
    timezone: job.timezone ?? null,
    kind: job.kind,
    payload: jobPayload(job),
  })
}

function jobPayload(job: CronJob): unknown {
  if (job.kind === 'prompt') return { prompt: job.prompt, subagent: job.subagent ?? null, payload: job.payload ?? null }
  return job.command
}

function computeNextFire(job: CronJob, now: number): number | null {
  try {
    const expr = CronExpressionParser.parse(job.schedule, {
      currentDate: new Date(now),
      ...(job.timezone ? { tz: job.timezone } : {}),
    })
    return expr.next().getTime()
  } catch {
    return null
  }
}
