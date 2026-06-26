import type { ResolveGithubTokenForRepo } from '@/channels/github-token-bridge'
import { getConfig, resolveModel, resolveProfile, type Models } from '@/config'
import { providerForModelRef } from '@/config/providers'
import type { PermissionService } from '@/permissions'

import type { PluginContext, PluginLogger, PluginModelInfo, PluginModels, SpawnSubagentOptions } from './types'

export type SpawnSubagentFn = (name: string, payload?: unknown, options?: SpawnSubagentOptions) => Promise<void>

export type CreatePluginContextOptions<TConfig> = {
  name: string
  version: string | undefined
  agentDir: string
  config: TConfig
  logger: PluginLogger
  permissions: PermissionService
  resolveGithubTokenForRepo?: ResolveGithubTokenForRepo
  hasGithubAppTokenResolver?: () => boolean
  spawnSubagent: SpawnSubagentFn
  isBooted: () => boolean
}

const githubTokenUnavailable: ResolveGithubTokenForRepo = async () => ({
  kind: 'unavailable',
  reason: 'GitHub token resolution is not wired in this context.',
})

export function createPluginContext<TConfig>(opts: CreatePluginContextOptions<TConfig>): PluginContext<TConfig> {
  const models = buildPluginModels(getConfig().models)
  return Object.freeze({
    name: opts.name,
    version: opts.version,
    agentDir: opts.agentDir,
    config: opts.config,
    models,
    // Presence-only by design: plugin code must not receive secret values here.
    hasSecret: (envName: string) => typeof process.env[envName] === 'string' && process.env[envName]!.length > 0,
    logger: opts.logger,
    permissions: opts.permissions,
    github: {
      resolveTokenForRepo: opts.resolveGithubTokenForRepo ?? githubTokenUnavailable,
      hasAppTokenResolver: opts.hasGithubAppTokenResolver ?? (() => false),
    },
    spawnSubagent: async (name: string, payload?: unknown, options?: SpawnSubagentOptions) => {
      if (!opts.isBooted()) {
        throw new Error(
          `plugin ${opts.name}: spawnSubagent("${name}") called before boot completed; subagent registry is not yet wired`,
        )
      }
      await opts.spawnSubagent(name, payload, options)
    },
  })
}

export function buildPluginModels(models: Models): PluginModels {
  const profiles = Object.keys(models).map((name) => pluginModelInfo(name, models[name]!.refs[0]!))
  const defaultModel =
    profiles.find((profile) => profile.profile === 'default') ?? pluginModelInfo('default', models.default.refs[0]!)

  return Object.freeze({
    default: defaultModel,
    profiles,
    resolve: (name: string) => {
      const resolved = resolveProfile(models, name)
      return pluginModelInfo(resolved.profile, resolved.ref)
    },
    usesProvider: (providerId: string) => profiles.some((profile) => profile.providerId === providerId),
  })
}

function pluginModelInfo(profile: string, ref: string): PluginModelInfo {
  const model = resolveModel(ref)
  return Object.freeze({
    profile,
    ref,
    providerId: providerForModelRef(ref),
    modelId: model.id,
    input: [...model.input],
    reasoning: model.reasoning,
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
