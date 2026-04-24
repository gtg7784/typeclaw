import { createSession } from '@/agent'
import {
  createExecRunner,
  createPromptRunner,
  createScheduler,
  type CronFile,
  type JobRunner,
  type LoadCronResult,
  loadCron as loadCronDefault,
  type Scheduler,
} from '@/cron'
import { createServer, type Server } from '@/server'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'

type BunServer = ReturnType<Server['start']>

export type TuiFactory = (options: TuiOptions) => { run: () => Promise<void> }

export type LoadCronFn = (agentDir: string) => Promise<LoadCronResult>
export type SchedulerFactory = (options: { cwd: string; file: CronFile }) => Scheduler

export type StartAgentOptions = {
  port: number
  attachTui: boolean
  initialPrompt?: string
  cwd?: string
  createTui?: TuiFactory
  loadCron?: LoadCronFn
  createSchedulerFor?: SchedulerFactory
}

export type StartAgentResult = {
  server: BunServer
  tuiPromise: Promise<void> | null
  scheduler: Scheduler | null
  stop: () => void
}

export async function startAgent({
  port,
  attachTui,
  initialPrompt,
  cwd = process.cwd(),
  createTui = createTuiDefault,
  loadCron = loadCronDefault,
  createSchedulerFor = defaultSchedulerFactory,
}: StartAgentOptions): Promise<StartAgentResult> {
  const server = createServer({ port }).start()

  const scheduler = await startScheduler({ cwd, loadCron, createSchedulerFor })

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    scheduler?.stop()
    server.stop(true)
  }

  if (!attachTui) {
    return { server, tuiPromise: null, scheduler, stop }
  }

  const url = `ws://localhost:${server.port}`
  const tui = createTui({ url, initialPrompt })
  const tuiPromise = tui.run()
  return { server, tuiPromise, scheduler, stop }
}

async function startScheduler({
  cwd,
  loadCron,
  createSchedulerFor,
}: {
  cwd: string
  loadCron: LoadCronFn
  createSchedulerFor: SchedulerFactory
}): Promise<Scheduler | null> {
  let result: LoadCronResult
  try {
    result = await loadCron(cwd)
  } catch (err) {
    console.error(`[cron] load failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
  if (!result.ok) {
    console.error(`[cron] failed to load cron.json: ${result.reason}`)
    return null
  }
  if (!result.file || result.file.jobs.length === 0) return null

  const scheduler = createSchedulerFor({ cwd, file: result.file })
  scheduler.start()
  return scheduler
}

function defaultSchedulerFactory({ cwd, file }: { cwd: string; file: CronFile }): Scheduler {
  const runner: JobRunner = {
    ...createPromptRunner({ createSessionForCron: () => createSession() }),
    ...createExecRunner({ cwd }),
  }
  return createScheduler({ jobs: file.jobs, runner })
}
