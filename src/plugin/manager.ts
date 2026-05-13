import { z } from 'zod'

import type { CronJob } from '@/cron'

import { createPluginContext, createPluginLogger, type SpawnSubagentFn } from './context'
import { createHookBus, type HookBus } from './hooks'
import { loadPluginEntry, type LoadPluginEntryFn, type ResolvedPlugin } from './loader'
import { discardRegistrationsBy, emptyRegistry, type PluginRegistry, registerContributions } from './registry'
import type { PluginExports } from './types'

export type LoadPluginsOptions = {
  entries: string[]
  agentDir: string
  configsByName: Record<string, unknown>
  loadEntry?: LoadPluginEntryFn
  // Bundled plugins resolved by the runtime (not from typeclaw.json). Loaded
  // before user-declared `entries` so a config block named after a bundled
  // plugin (e.g. "memory") is consumed by the bundled plugin, and so plugin-
  // name conflicts with a user-declared entry surface as a clear error.
  bundled?: ResolvedPlugin[]
}

export type LoadPluginsResult = {
  registry: PluginRegistry
  hooks: HookBus
  loadedPlugins: { name: string; version: string | undefined; source: string }[]
  markBooted: () => void
  setSpawnSubagent: (fn: SpawnSubagentFn) => void
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadPluginsResult> {
  const registry = emptyRegistry()
  const hooks = createHookBus()
  const loaded: { name: string; version: string | undefined; source: string }[] = []
  const loadEntry = opts.loadEntry ?? loadPluginEntry

  let booted = false
  let spawnSubagentImpl: SpawnSubagentFn = async () => {
    throw new Error('plugin: spawnSubagent is not yet wired')
  }

  const allPlugins: { entry: string; resolved: ResolvedPlugin }[] = [
    ...(opts.bundled?.map((resolved) => ({ entry: `<bundled:${resolved.name}>`, resolved })) ?? []),
    ...(await Promise.all(
      opts.entries.map(async (entry) => ({ entry, resolved: await loadEntry(entry, opts.agentDir) })),
    )),
  ]

  for (const { entry, resolved } of allPlugins) {
    if (loaded.find((l) => l.name === resolved.name)) {
      throw new Error(`plugin name conflict: ${resolved.name} (entry ${entry}) already loaded`)
    }

    let validatedConfig: unknown = undefined
    if (resolved.defined.configSchema) {
      const raw = opts.configsByName[resolved.name]
      const parsed = (resolved.defined.configSchema as z.ZodType<unknown>).safeParse(raw ?? {})
      if (!parsed.success) {
        throw new Error(`plugin ${resolved.name}: config invalid: ${formatZodIssues(parsed.error)}`)
      }
      validatedConfig = parsed.data
    } else if (opts.configsByName[resolved.name] !== undefined) {
      throw new Error(
        `plugin ${resolved.name}: config block "${resolved.name}" present in typeclaw.json but plugin declares no configSchema`,
      )
    }

    const logger = createPluginLogger(resolved.name)
    const ctx = createPluginContext({
      name: resolved.name,
      version: resolved.version,
      agentDir: opts.agentDir,
      config: validatedConfig as never,
      logger,
      spawnSubagent: (name, payload) => spawnSubagentImpl(name, payload),
      isBooted: () => booted,
    })

    let exports: PluginExports
    try {
      exports = await resolved.defined.plugin(ctx)
    } catch (err) {
      discardRegistrationsBy(resolved.name, registry, hooks)
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`plugin ${resolved.name}: factory threw: ${message}`)
    }

    try {
      registerContributions({
        pluginName: resolved.name,
        logger,
        exports,
        registry,
        hooks,
        agentDir: opts.agentDir,
        pluginConfig: validatedConfig,
      })
    } catch (err) {
      discardRegistrationsBy(resolved.name, registry, hooks)
      throw err
    }

    loaded.push({ name: resolved.name, version: resolved.version, source: resolved.source })
  }

  return {
    registry,
    hooks,
    loadedPlugins: loaded,
    markBooted: () => {
      booted = true
    },
    setSpawnSubagent: (fn) => {
      spawnSubagentImpl = fn
    },
  }
}

export function summarizeLoaded(loaded: LoadPluginsResult['loadedPlugins'], registry: PluginRegistry): string {
  const head = loaded.map((p) => (p.version !== undefined ? `${p.name} v${p.version}` : p.name)).join(', ')
  const counts = [
    `${registry.tools.length} tool(s)`,
    `${registry.subagents.length} subagent(s)`,
    `${registry.cronJobs.length} cron job(s)`,
    `${registry.skills.length} skill(s)`,
    `${registry.skillsDirs.length} skills dir(s)`,
    `${registry.doctorChecks.length} doctor check(s)`,
  ].join(', ')
  return `${loaded.length} plugin(s): ${head} [${counts}]`
}

export function pluginCronJobs(registry: PluginRegistry): CronJob[] {
  return registry.cronJobs.map((j) => j.job)
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`).join('; ')
}
