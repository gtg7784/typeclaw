import { join } from 'node:path'

import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'

import { getConfig } from '@/config'
import {
  KNOWN_PROVIDERS,
  providerForModelRef,
  supportsApiKey,
  supportsOAuth,
  type KnownProviderId,
} from '@/config/providers'
import { createSecretsStoreForAgent } from '@/secrets'

type Auth = {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
}

const TEST_DUMMY_API_KEY = 'test_dummy_key'

function secretsJsonPath(): string {
  return join(process.cwd(), 'secrets.json')
}

let cached: Auth | null = null

export function getAuth(): Auth {
  if (cached) return cached

  const providerId = providerForModelRef(getConfig().model)
  const provider = KNOWN_PROVIDERS[providerId]

  if (process.env.NODE_ENV === 'test' && !hasAnyCredentialInEnv(provider.apiKeyEnv)) {
    const authStorage = AuthStorage.inMemory()
    if (supportsApiKey(provider)) {
      authStorage.setRuntimeApiKey(provider.id, TEST_DUMMY_API_KEY)
    }
    const modelRegistry = ModelRegistry.create(authStorage)
    cached = { authStorage, modelRegistry }
    return cached
  }

  const authStorage = createSecretsStoreForAgent(secretsJsonPath())

  // Env-wins for api-key providers: when the canonical env var is set, layer
  // that value in via setRuntimeApiKey so AuthStorage's hasAuth resolves
  // true without persisting anything to secrets.json. This is the explicit
  // reversal of the pre-v2 auto-migrate-to-file behaviour.
  //
  // setRuntimeApiKey is in-memory only (it writes to runtimeOverrides, never
  // through withLock), so the file remains untouched even when the env var
  // is set. OAuth credentials in the file still take precedence on read
  // because AuthStorage's hasAuth checks runtimeOverrides first only for
  // api-key-shaped credentials — OAuth on disk wins on its own.
  //
  // The previous code branch that wrote the env value into secrets.json and
  // stripped the matching `.env` line has been removed. Env values stay in
  // env; the file stays user-owned. See src/secrets/hydrate.ts for the same
  // policy on the channels side.
  if (supportsApiKey(provider) && provider.apiKeyEnv) {
    const envKey = process.env[provider.apiKeyEnv]
    if (envKey !== undefined && envKey !== '') {
      const existing = authStorage.get(provider.id)
      if (existing === undefined || existing.type === 'api_key') {
        authStorage.setRuntimeApiKey(provider.id, envKey)
      }
    }
  }

  if (!authStorage.hasAuth(provider.id)) {
    console.error(missingCredentialMessage(providerId))
    process.exit(1)
  }

  const modelRegistry = ModelRegistry.create(authStorage)
  cached = { authStorage, modelRegistry }
  return cached
}

export function resetAuthForTesting(): void {
  cached = null
}

function hasAnyCredentialInEnv(apiKeyEnv: string | null): boolean {
  return apiKeyEnv !== null && process.env[apiKeyEnv] !== undefined && process.env[apiKeyEnv] !== ''
}

function missingCredentialMessage(providerId: KnownProviderId): string {
  const provider = KNOWN_PROVIDERS[providerId]
  const ref = getConfig().model
  const slash = ref.indexOf('/')
  const modelName =
    (provider.models as Record<string, { name: string }>)[ref.slice(slash + 1)]?.name ?? ref.slice(slash + 1)

  const oauthOnly = supportsOAuth(provider) && !supportsApiKey(provider)
  const apiKeyOnly = supportsApiKey(provider) && !supportsOAuth(provider)

  if (oauthOnly) {
    return `No credentials for ${provider.name}. Run \`typeclaw init\` and pick "OAuth" to log in to ${modelName}.`
  }
  if (apiKeyOnly && provider.apiKeyEnv) {
    return `Set ${provider.apiKeyEnv} in .env (or secrets.json#providers.${provider.id}.key.value) to use ${modelName} via ${provider.name}.`
  }
  return `No credentials for ${provider.name}. Either set ${provider.apiKeyEnv ?? '<api-key-env>'} in .env or run \`typeclaw init\` and pick "OAuth".`
}
