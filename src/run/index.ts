import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession, createSessionWithDispose } from '@/agent'
import type { SessionOrigin } from '@/agent/session-origin'
import {
  createSubagentConsumer,
  defaultCreateSessionForSubagent,
  invokeSubagent,
  type Subagent as InternalSubagent,
  type SubagentConsumer,
  type SubagentRegistry,
} from '@/agent/subagents'
import { createChannelManager, createChannelsReloadable, type ChannelManager } from '@/channels'
import { createConfigReloadable, getConfig, loadConfigSync, loadPluginConfigsSync } from '@/config'
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
import { loadPlugins, type LoadPluginsResult, pluginCronJobs, type PluginRegistry, summarizeLoaded } from '@/plugin'
import { createContainerBroker, publishForwardResult } from '@/portbroker'
import { ReloadRegistry } from '@/reload'
import { hydrateChannelEnvFromSecrets } from '@/secrets'
import { createServer, type Server } from '@/server'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import { createStream, type Stream } from '@/stream'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'

import { BUNDLED_PLUGINS } from './bundled-plugins'
import { buildChannelSessionFactory } from './channel-session-factory'
import { createPluginRuntime, type PluginRuntime, type PluginSubagentEntry } from './plugin-runtime'

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
  pluginRuntime: PluginRuntime
  loadedPlugins: LoadPluginsResult['loadedPlugins']
  channelManager: ChannelManager
  stop: () => void | Promise<void>
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

  // The host CLI sets TYPECLAW_CONTAINER_NAME when it `docker run`s us. When
  // running outside a typeclaw container (tests, ad-hoc `bun run typeclaw run`
  // outside docker), the env var is absent and the `restart` tool is omitted —
  // which is what we want, since there is no host daemon to honor it anyway.
  const containerName = process.env.TYPECLAW_CONTAINER_NAME
  const containerNameOpt = containerName !== undefined ? { containerName } : {}
  reloadRegistry.register(createConfigReloadable({ cwd }))

  const pluginConfigsByName = loadPluginConfigsSync(cwd)
  const cwdConfig = loadConfigSync(cwd)
  const pluginsLoaded = await loadPlugins({
    entries: cwdConfig.plugins,
    agentDir: cwd,
    configsByName: pluginConfigsByName,
    bundled: BUNDLED_PLUGINS,
    ...(cwdConfig.roles !== undefined ? { roles: cwdConfig.roles } : {}),
  })
  const pluginRegistry = pluginsLoaded.registry
  const pluginHooks = pluginsLoaded.hooks

  const { registry: subagents, pluginSubagentByShim, pluginSubagentByName } = mergeSubagents(pluginRegistry)

  const hasAnyPluginContent =
    pluginRegistry.tools.length > 0 ||
    pluginRegistry.subagents.length > 0 ||
    pluginRegistry.cronJobs.length > 0 ||
    pluginRegistry.skills.length > 0 ||
    pluginRegistry.skillsDirs.length > 0 ||
    pluginsLoaded.loadedPlugins.length > 0

  const pluginRuntime = createPluginRuntime({
    registry: pluginRegistry,
    hooks: pluginHooks,
    subagents,
    pluginSubagentByShim,
    hasAnyPluginContent,
    loadedPlugins: pluginsLoaded.loadedPlugins,
    materializedSkills: null,
  })

  // Channel adapters read `process.env[TOKEN_ENV]` (see channels/manager.ts).
  // Hydrate fills any unset env var from secrets.json#channels via env-wins:
  // values already in process.env (from `docker --env-file .env`) are kept
  // as-is; missing ones get the resolved Secret value injected. The pre-v2
  // auto-promotion from .env to secrets.json has been removed — env values
  // stay in env, the file stays user-owned. See src/secrets/hydrate.ts.
  hydrateChannelEnvFromSecrets({ agentDir: cwd })

  const channelManager = createChannelManager({
    agentDir: cwd,
    channelsConfigRef: () => getConfig().channels,
    aliasesRef: () => getConfig().alias,
    createSessionForChannel: buildChannelSessionFactory({
      cwd,
      sessionFactory,
      stream,
      reloadRegistry,
      pluginRuntime,
      getChannelRouter: () => channelManager.router,
      ...containerNameOpt,
    }),
  })

  const createSessionForSubagent: import('@/agent/subagents').CreateSessionForSubagent = async (
    subagent,
    subagentOptions,
  ) => {
    const snap = pluginRuntime.get()
    const entry = snap.pluginSubagentByShim.get(subagent)
    if (entry) {
      const sessionId = `subagent-${entry.pluginName}-${crypto.randomUUID()}`
      const origin: SessionOrigin = {
        kind: 'subagent' as const,
        subagent: subagentOptions?.name ?? entry.subagentName,
        parentSessionId: subagentOptions?.parentSessionId ?? '<unknown>',
        ...(subagentOptions?.spawnedByRole !== undefined ? { spawnedByRole: subagentOptions.spawnedByRole } : {}),
        ...(subagentOptions?.spawnedByOrigin !== undefined ? { spawnedByOrigin: subagentOptions.spawnedByOrigin } : {}),
      }
      const created = await createSessionWithDispose({
        systemPromptOverride: entry.pluginSubagent.systemPrompt,
        channelRouter: channelManager.router,
        origin,
        plugins: {
          registry: snap.registry,
          hooks: snap.hooks,
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
      return {
        ...created,
        hooks: snap.hooks,
        sessionId,
        agentDir: cwd,
        origin,
      }
    }
    return defaultCreateSessionForSubagent(subagent, subagentOptions)
  }

  const subagentConsumer = createSubagentConsumer({
    stream,
    getRegistry: () => pluginRuntime.get().subagents,
    agentDir: cwd,
    createSessionForSubagent,
    inFlightKey: (name, payload) => {
      const entry = pluginSubagentByName.get(name)
      const fn = entry?.pluginSubagent.inFlightKey
      if (fn !== undefined) {
        try {
          return `${name}:${fn(payload)}`
        } catch {
          return name
        }
      }
      return name
    },
  })
  subagentConsumer.start()

  const cronConsumer = createCronConsumer({
    stream,
    cwd,
    createSessionForCron: async (job) => {
      const snap = pluginRuntime.get()
      const sessionManager = SessionManager.create(cwd, sessionFactory.sessionDir())
      const sessionId = sessionManager.getSessionId()
      const cronOrigin: SessionOrigin = {
        kind: 'cron',
        jobId: job.id,
        jobKind: 'prompt',
        ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
        scheduledByOrigin: { kind: 'config-file' },
      }
      const session = await createSession({
        reloadRegistry,
        sessionManager,
        stream,
        channelRouter: channelManager.router,
        origin: cronOrigin,
        ...(snap.hasAnyPluginContent
          ? {
              plugins: {
                registry: snap.registry,
                hooks: snap.hooks,
                sessionId,
                agentDir: cwd,
              },
            }
          : {}),
        ...containerNameOpt,
      })
      return {
        prompt: (text) => session.prompt(text),
        dispose: () => session.dispose(),
        sessionId,
        agentDir: cwd,
        origin: cronOrigin,
        ...(snap.hasAnyPluginContent ? { hooks: snap.hooks } : {}),
        getTranscriptPath: () => sessionManager.getSessionFile(),
      }
    },
  })

  const internalJobs = () => pluginCronJobs(pluginRuntime.get().registry)
  const factory = createSchedulerFor ?? makeDefaultSchedulerFactory(internalJobs)
  const scheduler = await startScheduler({
    cwd,
    loadCron,
    createSchedulerFor: factory,
    stream,
    hasInternalJobs: internalJobs().length > 0,
    getSubagents: () => pluginRuntime.get().subagents,
  })

  if (scheduler) {
    cronConsumer.start()
    reloadRegistry.register(
      createCronReloadable({ cwd, scheduler, internalJobs, getSubagents: () => pluginRuntime.get().subagents }),
    )
  }

  reloadRegistry.register(createChannelsReloadable({ manager: channelManager }))
  await channelManager.start()

  pluginsLoaded.setSpawnSubagent(async (name, payload, options) => {
    // Resolve the spawning session's role from its origin so the subagent
    // inherits it. Callers (hooks like session.idle) pass the parent origin
    // verbatim; we look up the role rather than letting the caller forge it,
    // closing the laundering vector the design doc calls out for cron.
    const spawnedByRole =
      options?.spawnedByOrigin !== undefined
        ? pluginsLoaded.permissions.resolveRole(options.spawnedByOrigin)
        : undefined
    await invokeSubagent(name, {
      registry: pluginRuntime.get().subagents,
      createSessionForSubagent,
      agentDir: cwd,
      userPrompt: '',
      payload,
      ...(options?.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
      ...(spawnedByRole !== undefined ? { spawnedByRole } : {}),
      ...(options?.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
    })
  })
  pluginsLoaded.markBooted()

  if (pluginsLoaded.loadedPlugins.length > 0) {
    console.log(`[plugin] loaded ${summarizeLoaded(pluginsLoaded.loadedPlugins, pluginRegistry)}`)
  }

  // Container-side portbroker is instantiated only when the host plumbed a
  // broker token in via env var. Outside the container (tests, ad-hoc dev
  // runs), the env var is absent and the broker stays off — same fence as
  // TYPECLAW_CONTAINER_NAME guards the restart tool.
  const brokerTokenEnv = process.env.TYPECLAW_HOSTD_BROKER_TOKEN
  const containerBroker =
    brokerTokenEnv !== undefined && brokerTokenEnv.length > 0
      ? createContainerBroker({
          expectedToken: brokerTokenEnv,
          onLog: (event) => {
            if (event.kind === 'subscribed') return
            stream.publish({
              target: { kind: 'broadcast' },
              payload: { kind: 'portbroker-log', event },
            })
          },
          // Re-publish to the in-process bus so consumers (today: the
          // agent-browser plugin's bind-with-forward retry loop) can subscribe
          // without holding a reference to the broker. See src/portbroker/
          // forward-result-bus.ts for the contract.
          onForwardResult: (event) => publishForwardResult(event),
        })
      : undefined
  const containerBrokerOpt = containerBroker ? { containerBroker } : {}

  const server = createServer({
    port,
    reloadAll: () => reloadRegistry.reloadAll(),
    reloadRegistry,
    sessionFactory,
    stream,
    channelRouter: channelManager.router,
    agentDir: cwd,
    pluginRuntime,
    ...containerNameOpt,
    ...containerBrokerOpt,
  }).start()

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    scheduler?.stop()
    cronConsumer.stop()
    subagentConsumer.stop()
    server.stop(true)
    void disposeMaterializedSkills(pluginRuntime)
    await channelManager.stop()
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
      pluginRuntime,
      loadedPlugins: pluginsLoaded.loadedPlugins,
      channelManager,
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
    pluginRuntime,
    loadedPlugins: pluginsLoaded.loadedPlugins,
    channelManager,
    stop,
  }
}

async function disposeMaterializedSkills(pluginRuntime: PluginRuntime): Promise<void> {
  const pending = pluginRuntime.drainPendingDisposal()
  const current = pluginRuntime.get().materializedSkills
  const all = current ? [...pending, current] : pending
  await Promise.allSettled(all.map((m) => m.dispose()))
}

async function startScheduler({
  cwd,
  loadCron,
  createSchedulerFor,
  stream,
  hasInternalJobs,
  getSubagents,
}: {
  cwd: string
  loadCron: LoadCronFn
  createSchedulerFor: SchedulerFactory
  stream: Stream
  hasInternalJobs: boolean
  getSubagents?: () => SubagentRegistry
}): Promise<Scheduler | null> {
  let result: LoadCronResult
  const subagents = getSubagents?.()
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

function mergeSubagents(pluginRegistry: PluginRegistry): {
  registry: SubagentRegistry
  pluginSubagentByShim: WeakMap<InternalSubagent<any>, PluginSubagentEntry>
  pluginSubagentByName: Map<string, PluginSubagentEntry>
} {
  const merged: Record<string, InternalSubagent<any>> = {}
  const pluginSubagentByShim = new WeakMap<InternalSubagent<any>, PluginSubagentEntry>()
  const pluginSubagentByName = new Map<string, PluginSubagentEntry>()
  for (const reg of pluginRegistry.subagents) {
    if (merged[reg.subagentName] !== undefined) {
      throw new Error(
        `plugin ${reg.pluginName}: subagent name "${reg.subagentName}" already registered (across plugins)`,
      )
    }
    const shim = pluginSubagentShim(reg.subagent)
    merged[reg.subagentName] = shim
    const entry: PluginSubagentEntry = {
      pluginName: reg.pluginName,
      subagentName: reg.subagentName,
      pluginSubagent: reg.subagent,
    }
    pluginSubagentByShim.set(shim, entry)
    pluginSubagentByName.set(reg.subagentName, entry)
  }
  return { registry: merged, pluginSubagentByShim, pluginSubagentByName }
}

function pluginSubagentShim(subagent: import('@/plugin').Subagent<any>): InternalSubagent<any> {
  return {
    systemPrompt: subagent.systemPrompt,
    ...(subagent.payloadSchema ? { payloadSchema: subagent.payloadSchema } : {}),
    ...(subagent.handler ? { handler: subagent.handler as InternalSubagent<any>['handler'] } : {}),
  }
}
