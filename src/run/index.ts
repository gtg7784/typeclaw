import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession } from '@/agent'
import { createSubagentConsumer, defaultCreateSessionForSubagent, type SubagentConsumer } from '@/agent/subagents'
import { config, type Config, createConfigReloadable, getConfig } from '@/config'
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
} from '@/cron'
import { dreamingSubagent, isDreamingPayload, isMemoryLoggerPayload, memoryLoggerSubagent } from '@/memory'
import { ReloadRegistry } from '@/reload'
import { createServer, type Server } from '@/server'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import { createStream, type Stream } from '@/stream'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'

const DREAMING_JOB_ID = '__internal_dreaming'

type BunServer = ReturnType<Server['start']>

export type TuiFactory = (options: TuiOptions) => { run: () => Promise<void> }

export type LoadCronFn = (
  agentDir: string,
  options?: { subagents?: import('@/agent/subagents').SubagentRegistry },
) => Promise<LoadCronResult>
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
  reloadRegistry.register(createConfigReloadable({ cwd }))

  const subagents = {
    'memory-logger': memoryLoggerSubagent,
    dreaming: dreamingSubagent,
  }

  const subagentConsumer = createSubagentConsumer({
    stream,
    registry: subagents,
    agentDir: cwd,
    createSessionForSubagent: defaultCreateSessionForSubagent,
    inFlightKey: (name, payload) => {
      if (name === 'memory-logger' && isMemoryLoggerPayload(payload)) {
        return `${name}:${payload.parentSessionId}`
      }
      if (name === 'dreaming' && isDreamingPayload(payload)) {
        return `${name}:${payload.agentDir}`
      }
      return name
    },
  })
  subagentConsumer.start()

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

  const internalJobs = () => buildInternalJobs(cwd, getConfig())
  const factory = createSchedulerFor ?? makeDefaultSchedulerFactory(internalJobs)
  const scheduler = await startScheduler({
    cwd,
    loadCron,
    createSchedulerFor: factory,
    stream,
    hasInternalJobs: internalJobs().length > 0,
    subagents,
  })

  if (scheduler) {
    cronConsumer.start()
    reloadRegistry.register(createCronReloadable({ cwd, scheduler, internalJobs, subagents }))
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
  subagents,
}: {
  cwd: string
  loadCron: LoadCronFn
  createSchedulerFor: SchedulerFactory
  stream: Stream
  hasInternalJobs: boolean
  subagents?: import('@/agent/subagents').SubagentRegistry
}): Promise<Scheduler | null> {
  let result: LoadCronResult
  try {
    result = await loadCron(cwd, subagents !== undefined ? { subagents } : {})
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
    jobs.push({
      id: DREAMING_JOB_ID,
      schedule: dreaming.schedule,
      enabled: true,
      kind: 'prompt',
      prompt: '(internal: dreaming consolidation; user prompt is built by the dreaming subagent handler)',
      subagent: 'dreaming',
      payload: { agentDir: cwd },
    })
  }
  return jobs
}
