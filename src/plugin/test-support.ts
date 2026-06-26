import type { PluginModelInfo, PluginModels } from './types'

export function stubPluginModels(
  opts: {
    defaultProviderId?: string
    profiles?: Partial<PluginModelInfo>[]
  } = {},
): PluginModels {
  const defaultModel = stubModel({ profile: 'default', providerId: opts.defaultProviderId ?? 'fireworks' })
  const profiles = [defaultModel, ...(opts.profiles ?? []).map((profile, index) => stubModel(profile, index))]

  return {
    default: defaultModel,
    profiles,
    resolve: (profile: string) => profiles.find((model) => model.profile === profile) ?? defaultModel,
    usesProvider: (providerId: string) => profiles.some((model) => model.providerId === providerId),
  }
}

function stubModel(overrides: Partial<PluginModelInfo>, index = 0): PluginModelInfo {
  const profile = overrides.profile ?? `profile-${index + 1}`
  const providerId = overrides.providerId ?? 'fireworks'
  const modelId = overrides.modelId ?? 'stub-model'
  return {
    profile,
    ref: overrides.ref ?? `${providerId}/${modelId}`,
    providerId,
    modelId,
    input: overrides.input ?? ['text'],
    reasoning: overrides.reasoning ?? false,
  }
}
