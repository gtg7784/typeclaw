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

// Per-provider cache. Sessions that use a profile mapped to provider X share
// a single AuthStorage + ModelRegistry for that provider; first use of a new
// provider lazily resolves its credentials. This replaces the singleton
// `getAuth()` from before multi-model — the singleton couldn't represent
// "auth for `default` is OpenAI, auth for `vision` is Fireworks" without
// constructing both at boot.
const cached = new Map<KnownProviderId, Auth>()

export function getAuthFor(providerId: KnownProviderId): Auth {
  const existing = cached.get(providerId)
  if (existing) return existing

  const provider = KNOWN_PROVIDERS[providerId]

  if (process.env.NODE_ENV === 'test' && !hasAnyCredentialInEnv(provider.apiKeyEnv)) {
    const authStorage = AuthStorage.inMemory()
    if (supportsApiKey(provider)) {
      authStorage.setRuntimeApiKey(provider.id, TEST_DUMMY_API_KEY)
    }
    const modelRegistry = ModelRegistry.create(authStorage)
    const auth = { authStorage, modelRegistry }
    cached.set(providerId, auth)
    return auth
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
  if (supportsApiKey(provider) && provider.apiKeyEnv) {
    const envKey = process.env[provider.apiKeyEnv]
    if (envKey !== undefined && envKey !== '') {
      const existingCred = authStorage.get(provider.id)
      if (existingCred === undefined || existingCred.type === 'api_key') {
        authStorage.setRuntimeApiKey(provider.id, envKey)
      }
    }
  }

  if (!authStorage.hasAuth(provider.id)) {
    console.error(missingCredentialMessage(providerId))
    process.exit(1)
  }

  const modelRegistry = ModelRegistry.create(authStorage)
  const auth = { authStorage, modelRegistry }
  cached.set(providerId, auth)
  return auth
}

// Back-compat shim for callers that still want the `default` profile's auth
// (the main session path). Equivalent to `getAuthFor(provider-of-default)`.
// Uses the head of the fallback chain; auth for the rest of the chain is
// resolved lazily when fallback actually fires.
export function getAuth(): Auth {
  const defaultRef = getConfig().models.default.refs[0]!
  return getAuthFor(providerForModelRef(defaultRef))
}

export function resetAuthForTesting(): void {
  cached.clear()
}

function hasAnyCredentialInEnv(apiKeyEnv: string | null): boolean {
  return apiKeyEnv !== null && process.env[apiKeyEnv] !== undefined && process.env[apiKeyEnv] !== ''
}

function missingCredentialMessage(providerId: KnownProviderId): string {
  const provider = KNOWN_PROVIDERS[providerId]
  const defaultRef = getConfig().models.default.refs[0]!
  const defaultProviderId = providerForModelRef(defaultRef)
  // For the `default` profile, name the model in the error message (matches
  // pre-multi-model behavior). For any other profile, the user is mixing
  // providers across profiles and the error must name the failing provider
  // without claiming it's tied to the `default` model.
  const isDefault = defaultProviderId === providerId
  const ref = isDefault ? defaultRef : null
  const modelName =
    ref !== null
      ? ((provider.models as Record<string, { name: string }>)[ref.slice(ref.indexOf('/') + 1)]?.name ??
        ref.slice(ref.indexOf('/') + 1))
      : null

  const oauthOnly = supportsOAuth(provider) && !supportsApiKey(provider)
  const apiKeyOnly = supportsApiKey(provider) && !supportsOAuth(provider)

  if (oauthOnly) {
    return modelName
      ? `No credentials for ${provider.name}. Run \`typeclaw init\` and pick "OAuth" to log in to ${modelName}.`
      : `No credentials for ${provider.name} (referenced by a non-default profile). Run \`typeclaw init\` and pick "OAuth" to log in.`
  }
  if (apiKeyOnly && provider.apiKeyEnv) {
    return modelName
      ? `Run \`typeclaw init\` to add an API key for ${modelName} via ${provider.name} (stored in secrets.json#providers.${provider.id}.key.value; ${provider.apiKeyEnv} in .env also works for override).`
      : `Run \`typeclaw init\` to add an API key for ${provider.name} (referenced by a non-default profile; stored in secrets.json#providers.${provider.id}.key.value; ${provider.apiKeyEnv} in .env also works for override).`
  }
  return `No credentials for ${provider.name}. Run \`typeclaw init\` to add an API key (stored in secrets.json) or pick "OAuth".`
}
