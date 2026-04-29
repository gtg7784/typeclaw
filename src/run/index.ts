import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession, createSessionWithDispose } from '@/agent'
import {
  createSubagentConsumer,
  defaultCreateSessionForSubagent,
  invokeSubagent,
  type Subagent as InternalSubagent,
  type SubagentConsumer,
  type SubagentRegistry,
} from '@/agent/subagents'
import { config, type Config, createConfigReloadable, getConfig, loadConfigSync, loadPluginConfigsSync } from '@/config'
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
import {
  type HookBus,
  loadPlugins,
  type LoadPluginsResult,
  pluginCronJobs,
  type PluginRegistry,
  summarizeLoaded,
} from '@/plugin'
import { ReloadRegistry } from '@/reload'
import { createServer, type Server } from '@/server'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import { createStream, type Stream } from '@/stream'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'

const DREAMING_JOB_ID = '__internal_dreaming'

type BunServer = ReturnType<Server['start']>

export type TuiFactory = (options: TuiOptions) => { run: () => Promise<void> }

export type LoadCronFn = (agentDir: string, options?: { subagents?: SubagentRegistry }) => Promise<LoadCronResult>
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
  pluginRegistry: PluginRegistry
  pluginHooks: HookBus
  loadedPlugins: LoadPluginsResult['loadedPlugins']
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

  const pluginConfigsByName = loadPluginConfigsSync(cwd)
  const cwdConfig = loadConfigSync(cwd)
  const pluginsLoaded = await loadPlugins({
    entries: cwdConfig.plugins,
    agentDir: cwd,
    configsByName: pluginConfigsByName,
  })
  const pluginRegistry = pluginsLoaded.registry
  const pluginHooks = pluginsLoaded.hooks

  const { registry: subagents, pluginSubagentByShim } = mergeSubagents(pluginRegistry)

  const createSessionForSubagent: import('@/agent/subagents').CreateSessionForSubagent = async (subagent) => {
    const entry = pluginSubagentByShim.get(subagent)
    if (entry) {
      const sessionId = `subagent-${entry.pluginName}-${crypto.randomUUID()}`
      return createSessionWithDispose({
        systemPromptOverride: entry.pluginSubagent.systemPrompt,
        plugins: {
          registry: pluginRegistry,
          hooks: pluginHooks,
          sessionId,
          agentDir: cwd,
        },
        pluginSubagent: {
          pluginName: entry.pluginName,
          ...(entry.pluginSubagent.tools ? { toolRefs: entry.pluginSubagent.tools } : {}),
          ...(entry.pluginSubagent.customTools ? { customTools: entry.pluginSubagent.customTools } : {}),
          toolNamePrefix: `__plugin_${entry.pluginName}_${entry.subagentName}`,
        },
      })
    }
    return defaultCreateSessionForSubagent(subagent)
  }

  const subagentConsumer = createSubagentConsumer({
    stream,
    registry: subagents,
    agentDir: cwd,
    createSessionForSubagent,
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

  const hasAnyPluginContent =
    pluginRegistry.tools.length > 0 ||
    pluginRegistry.subagents.length > 0 ||
    pluginRegistry.cronJobs.length > 0 ||
    pluginRegistry.skills.length > 0 ||
    pluginRegistry.skillsDirs.length > 0 ||
    pluginsLoaded.loadedPlugins.length > 0

  const cronConsumer = createCronConsumer({
    stream,
    cwd,
    createSessionForCron: () =>
      createSession({
        reloadRegistry,
        sessionManager: SessionManager.create(cwd, sessionFactory.sessionDir()),
        stream,
        ...(hasAnyPluginContent
          ? {
              plugins: {
                registry: pluginRegistry,
                hooks: pluginHooks,
                sessionId: `cron-${crypto.randomUUID()}`,
                agentDir: cwd,
              },
            }
          : {}),
      }),
  })

  const internalJobs = () => [...buildInternalJobs(cwd, getConfig()), ...pluginCronJobs(pluginRegistry)]
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

  pluginsLoaded.setSpawnSubagent(async (name, payload) => {
    await invokeSubagent(name, {
      registry: subagents,
      agentDir: cwd,
      userPrompt: '',
      payload,
    })
  })
  pluginsLoaded.markBooted()

  if (pluginsLoaded.loadedPlugins.length > 0) {
    console.log(`[plugin] loaded ${summarizeLoaded(pluginsLoaded.loadedPlugins, pluginRegistry)}`)
  }

  const server = createServer({
    port,
    reloadAll: () => reloadRegistry.reloadAll(),
    reloadRegistry,
    sessionFactory,
    stream,
    memoryIdleMs: config.memory.idleMs,
    agentDir: cwd,
    pluginRegistry,
    pluginHooks,
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
      pluginRegistry,
      pluginHooks,
      loadedPlugins: pluginsLoaded.loadedPlugins,
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
    pluginRegistry,
    pluginHooks,
    loadedPlugins: pluginsLoaded.loadedPlugins,
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
  subagents?: SubagentRegistry
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

type PluginSubagentEntry = {
  pluginName: string
  subagentName: string
  pluginSubagent: import('@/plugin').Subagent<any>
}

function mergeSubagents(pluginRegistry: PluginRegistry): {
  registry: SubagentRegistry
  pluginSubagentByShim: WeakMap<InternalSubagent<any>, PluginSubagentEntry>
} {
  const merged: Record<string, InternalSubagent<any>> = {
    'memory-logger': memoryLoggerSubagent,
    dreaming: dreamingSubagent,
  }
  const pluginSubagentByShim = new WeakMap<InternalSubagent<any>, PluginSubagentEntry>()
  for (const reg of pluginRegistry.subagents) {
    if (merged[reg.subagentName] !== undefined) {
      throw new Error(
        `plugin ${reg.pluginName}: subagent name "${reg.subagentName}" conflicts with a built-in subagent`,
      )
    }
    const shim = pluginSubagentShim(reg.subagent)
    merged[reg.subagentName] = shim
    pluginSubagentByShim.set(shim, {
      pluginName: reg.pluginName,
      subagentName: reg.subagentName,
      pluginSubagent: reg.subagent,
    })
  }
  return { registry: merged, pluginSubagentByShim }
}

function pluginSubagentShim(subagent: import('@/plugin').Subagent<any>): InternalSubagent<any> {
  return {
    systemPrompt: subagent.systemPrompt,
    ...(subagent.payloadSchema ? { payloadSchema: subagent.payloadSchema } : {}),
    ...(subagent.handler ? { handler: subagent.handler as InternalSubagent<any>['handler'] } : {}),
  }
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
