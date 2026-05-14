import type { PermissionService } from '@/permissions'

import type { PluginContext, PluginLogger } from './types'

export type SpawnSubagentFn = (name: string, payload?: unknown) => Promise<void>

export type CreatePluginContextOptions<TConfig> = {
  name: string
  version: string | undefined
  agentDir: string
  config: TConfig
  logger: PluginLogger
  permissions: PermissionService
  spawnSubagent: SpawnSubagentFn
  isBooted: () => boolean
}

export function createPluginContext<TConfig>(opts: CreatePluginContextOptions<TConfig>): PluginContext<TConfig> {
  return Object.freeze({
    name: opts.name,
    version: opts.version,
    agentDir: opts.agentDir,
    config: opts.config,
    logger: opts.logger,
    permissions: opts.permissions,
    spawnSubagent: async (name: string, payload?: unknown) => {
      if (!opts.isBooted()) {
        throw new Error(
          `plugin ${opts.name}: spawnSubagent("${name}") called before boot completed; subagent registry is not yet wired`,
        )
      }
      await opts.spawnSubagent(name, payload)
    },
  })
}

export function createPluginLogger(name: string): PluginLogger {
  const prefix = `[plugin:${name}]`
  return {
    info: (m) => console.log(`${prefix} ${m}`),
    warn: (m) => console.warn(`${prefix} ${m}`),
    error: (m) => console.error(`${prefix} ${m}`),
  }
}
