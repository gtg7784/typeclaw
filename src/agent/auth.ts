import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'

import { getConfig } from '@/config'
import { KNOWN_PROVIDERS, providerForModelRef, type KnownProviderId } from '@/config/providers'

type Auth = {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
}

const TEST_DUMMY_API_KEY = 'test_dummy_key'

let cached: Auth | null = null

export function getAuth(): Auth {
  if (cached) return cached

  const providerId = providerForModelRef(getConfig().model)
  const provider = KNOWN_PROVIDERS[providerId]

  // Bun sets NODE_ENV=test automatically under `bun test`. Use a dummy key
  // there so suites that build sessions but never hit the LLM don't need real
  // credentials; production still hard-exits to surface misconfiguration.
  const apiKey = process.env[provider.apiKeyEnv] ?? (process.env.NODE_ENV === 'test' ? TEST_DUMMY_API_KEY : undefined)
  if (!apiKey) {
    console.error(`Set ${provider.apiKeyEnv} to use ${describeModel(providerId)} via ${provider.name}.`)
    process.exit(1)
  }

  const authStorage = AuthStorage.create()
  authStorage.setRuntimeApiKey(provider.id, apiKey)
  const modelRegistry = ModelRegistry.create(authStorage)

  cached = { authStorage, modelRegistry }
  return cached
}

export function resetAuthForTesting(): void {
  cached = null
}

function describeModel(providerId: KnownProviderId): string {
  const ref = getConfig().model
  const slash = ref.indexOf('/')
  const modelId = ref.slice(slash + 1)
  const model = (KNOWN_PROVIDERS[providerId].models as Record<string, { name: string }>)[modelId]
  return model?.name ?? modelId
}
