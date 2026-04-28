import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession } from '@/agent'
import { type Config, config } from '@/config'
import {
  type CronConsumer,
  type CronJob,
  type CronFile,
  createCronConsumer,
  createCronReloadable,
  createScheduler,
  type LoadCronResult,
  loadCron as loadCronDefault,
  type Scheduler,
  type SubagentJob,
} from '@/cron'
import { createDreamingSpawner, createMemoryLoggerSpawner, isDreamingPayload, isMemoryLoggerPayload } from '@/memory'
import { ReloadRegistry } from '@/reload'
import { createServer, type Server } from '@/server'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import { createStream, type Stream } from '@/stream'
import { createSubagentConsumer, type SubagentConsumer } from '@/subagent'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'

const DREAMING_JOB_ID = '__internal_dreaming'

type BunServer = ReturnType<Server['start']>

export type TuiFactory = (options: TuiOptions) => { run: () => Promise<void> }

export type LoadCronFn = (agentDir: string) => Promise<LoadCronResult>
export type SchedulerFactory = (options: { cwd: string; file: CronFile; onFire: (job: CronJob) => void }) => Scheduler

export type StartAgentOptions = {
  port: number
  attachTui: boolean
  initialPrompt?: string
  cwd?: string
  createTui?: TuiFactory
  loadCron?: LoadCronFn
  createSchedulerFor?: SchedulerFactory
  sessionFactory?: SessionFactory
  stream?: Stream
}

export type StartAgentResult = {
  server: BunServer
  tuiPromise: Promise<void> | null
  scheduler: Scheduler | null
  cronConsumer: CronConsumer | null
  subagentConsumer: SubagentConsumer
  reloadRegistry: ReloadRegistry
  stream: Stream
  stop: () => void
}

export async function startAgent({
  port,
  attachTui,
  initialPrompt,
  cwd = process.cwd(),
  createTui = createTuiDefault,
  loadCron = loadCronDefault,
  createSchedulerFor,
  sessionFactory = createSessionFactory({ agentDir: cwd }),
  stream = createStream(),
}: StartAgentOptions): Promise<StartAgentResult> {
  const reloadRegistry = new ReloadRegistry()

  const cronConsumer = createCronConsumer({
    stream,
    cwd,
    createSessionForCron: () =>
      createSession({
        reloadRegistry,
        sessionManager: SessionManager.create(cwd, sessionFactory.sessionDir()),
        stream,
      }),
  })

  const subagentConsumer = createSubagentConsumer({
    stream,
    spawners: {
      'memory-logger': createMemoryLoggerSpawner(),
      dreaming: createDreamingSpawner(),
    },
    inFlightKey: (subagent, payload) => {
      if (subagent === 'memory-logger' && isMemoryLoggerPayload(payload)) {
        return `${subagent}:${payload.parentSessionId}`
      }
      if (subagent === 'dreaming' && isDreamingPayload(payload)) {
        return `${subagent}:${payload.agentDir}`
      }
      return subagent
    },
  })
  subagentConsumer.start()

  const internalJobs = () => buildInternalJobs(cwd, config)
  const factory = createSchedulerFor ?? makeDefaultSchedulerFactory(internalJobs)
  const scheduler = await startScheduler({
    cwd,
    loadCron,
    createSchedulerFor: factory,
    stream,
    hasInternalJobs: internalJobs().length > 0,
  })

  if (scheduler) {
    cronConsumer.start()
    reloadRegistry.register(createCronReloadable({ cwd, scheduler, internalJobs }))
  }

  const server = createServer({
    port,
    reloadAll: () => reloadRegistry.reloadAll(),
    reloadRegistry,
    sessionFactory,
    stream,
    memoryIdleMs: config.memory.idleMs,
    agentDir: cwd,
  }).start()

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    scheduler?.stop()
    cronConsumer.stop()
    subagentConsumer.stop()
    server.stop(true)
  }

  if (!attachTui) {
    return {
      server,
      tuiPromise: null,
      scheduler,
      cronConsumer: scheduler ? cronConsumer : null,
      subagentConsumer,
      reloadRegistry,
      stream,
      stop,
    }
  }

  const url = `ws://localhost:${server.port}`
  const tui = createTui({ url, initialPrompt })
  const tuiPromise = tui.run()
  return {
    server,
    tuiPromise,
    scheduler,
    cronConsumer: scheduler ? cronConsumer : null,
    subagentConsumer,
    reloadRegistry,
    stream,
    stop,
  }
}

async function startScheduler({
  cwd,
  loadCron,
  createSchedulerFor,
  stream,
  hasInternalJobs,
}: {
  cwd: string
  loadCron: LoadCronFn
  createSchedulerFor: SchedulerFactory
  stream: Stream
  hasInternalJobs: boolean
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
  // Without cron.json, the scheduler still needs to run if internal jobs
  // (like dreaming) are configured. Construct an empty file in that case.
  const file: CronFile = result.file ?? { jobs: [] }
  if (!result.file && !hasInternalJobs) return null

  const onFire = (job: CronJob) => {
    stream.publish({ target: { kind: 'cron', jobId: job.id }, payload: job })
  }
  const scheduler = createSchedulerFor({ cwd, file, onFire })
  scheduler.start()
  return scheduler
}

function makeDefaultSchedulerFactory(internalJobs: () => CronJob[]): SchedulerFactory {
  return ({ file, onFire }) => createScheduler({ jobs: [...file.jobs, ...internalJobs()], onFire })
}

function buildInternalJobs(cwd: string, cfg: Config): CronJob[] {
  const jobs: CronJob[] = []
  const dreaming = cfg.memory.dreaming
  if (dreaming) {
    const job: SubagentJob = {
      id: DREAMING_JOB_ID,
      schedule: dreaming.schedule,
      enabled: true,
      kind: 'subagent',
      subagent: 'dreaming',
      payload: { agentDir: cwd },
    }
    jobs.push(job)
  }
  return jobs
}
