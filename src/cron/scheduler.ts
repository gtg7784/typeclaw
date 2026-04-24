import { CronExpressionParser } from 'cron-parser'

import type { CronJob, ExecJob, PromptJob } from './schema'

export type JobRunner = {
  runPrompt: (job: PromptJob) => Promise<void>
  runExec: (job: ExecJob) => Promise<void>
}

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
  runner: JobRunner
  clock?: SchedulerClock
  logger?: SchedulerLogger
  onError?: (job: CronJob, error: unknown) => void
}

export type Scheduler = {
  start: () => void
  stop: () => void
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
  runner,
  clock = realClock,
  logger = consoleLogger,
  onError,
}: CreateSchedulerOptions): Scheduler {
  const handleError = onError ?? ((job: CronJob, err: unknown) => defaultOnError(logger, job, err))
  const enabled = jobs.filter((j) => j.enabled)
  const handles = new Map<string, number>()
  const running = new Set<string>()
  let started = false

  function scheduleNext(job: CronJob): void {
    if (!started) return

    const nextFire = computeNextFire(job, clock.now())
    if (nextFire === null) return

    const delay = Math.max(0, nextFire - clock.now())
    const handle = clock.setTimeout(() => {
      handles.delete(job.id)
      if (!started) return
      // Coalesce-skip: if the previous invocation hasn't finished, drop this
      // tick rather than queuing a parallel run. This honors "best effort".
      if (running.has(job.id)) {
        logger.warn(`[cron] ${job.id}: previous run still in progress, skipping tick`)
        scheduleNext(job)
        return
      }
      fire(job)
    }, delay)
    handles.set(job.id, handle)
  }

  function fire(job: CronJob): void {
    running.add(job.id)
    logger.info(`[cron] firing ${job.kind} ${job.id}`)
    const done = (err?: unknown) => {
      running.delete(job.id)
      if (err !== undefined) handleError(job, err)
      scheduleNext(job)
    }
    const promise = job.kind === 'prompt' ? runner.runPrompt(job) : runner.runExec(job)
    promise.then(
      () => done(),
      (err) => done(err),
    )
  }

  return {
    start() {
      if (started) return
      started = true
      for (const job of enabled) scheduleNext(job)
    },
    stop() {
      started = false
      for (const handle of handles.values()) clock.clearTimeout(handle)
      handles.clear()
    },
  }
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

function defaultOnError(logger: SchedulerLogger, job: CronJob, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  logger.error(`[cron] ${job.id} failed: ${message}`)
}
