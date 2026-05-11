import { join } from 'node:path'

import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'

import { createAuthStorageForAgent } from '@/auth'
import { getConfig } from '@/config'
import {
  KNOWN_PROVIDERS,
  providerForModelRef,
  supportsApiKey,
  supportsOAuth,
  type KnownProviderId,
} from '@/config/providers'

type Auth = {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
}

const TEST_DUMMY_API_KEY = 'test_dummy_key'

// In container stage, /agent is the bind-mounted agent folder; in host stage
// (only used by `typeclaw init` itself), it falls back to process.cwd(). The
// host writes auth.json at init time and the container reads + refreshes it
// at runtime — both paths point at the same file on the host filesystem.
function authJsonPath(): string {
  return join(process.cwd(), 'auth.json')
}

let cached: Auth | null = null

export function getAuth(): Auth {
  if (cached) return cached

  const providerId = providerForModelRef(getConfig().model)
  const provider = KNOWN_PROVIDERS[providerId]

  // Bun sets NODE_ENV=test automatically under `bun test`. The dummy path
  // bypasses both auth.json and process.env so suites that build sessions
  // but never hit the LLM don't need real credentials; production still
  // hard-exits to surface misconfiguration.
  if (process.env.NODE_ENV === 'test' && !hasAnyCredentialInEnv(provider.apiKeyEnv)) {
    const authStorage = AuthStorage.inMemory()
    if (supportsApiKey(provider)) {
      authStorage.setRuntimeApiKey(provider.id, TEST_DUMMY_API_KEY)
    }
    const modelRegistry = ModelRegistry.create(authStorage)
    cached = { authStorage, modelRegistry }
    return cached
  }

  const authStorage = createAuthStorageForAgent(authJsonPath())

  // Persist the .env API key into auth.json so the file is the single
  // source of truth for credentials. Upstream pi-ai's `getEnvApiKey()` only
  // knows about a hardcoded set of providers (anthropic, openai, etc.) and
  // does NOT know about Fireworks, so `hasAuth("fireworks")` returns false
  // unless a credential is materialized into AuthStorage's data map. Before
  // this migration the code used `setRuntimeApiKey`, which papered over the
  // gap in-memory but never wrote auth.json — leaving `llm` empty for every
  // downstream consumer (rotation, audit, transport over the daemon
  // boundary) that treats the file as authoritative.
  //
  // Policy: never overwrite an existing OAuth credential. The user
  // explicitly logged in at init, and an unrelated `.env` value must not
  // silently displace it. Only write when no credential exists, or when an
  // existing api-key value drifted from the env var (the user rotated the
  // key in .env and expects the next boot to pick it up).
  if (supportsApiKey(provider) && provider.apiKeyEnv) {
    const envKey = process.env[provider.apiKeyEnv]
    if (envKey) {
      const existing = authStorage.get(provider.id)
      const needsWrite = existing === undefined || (existing.type === 'api_key' && existing.key !== envKey)
      if (needsWrite) {
        authStorage.set(provider.id, { type: 'api_key', key: envKey })
      }
    }
  }

  // OAuth providers persist via `oauth-login.ts` at init time; api-key
  // providers persist via the migration block above. By this point
  // auth.json is authoritative — a missing entry means the user skipped
  // login at init, deleted the file, or never set the provider's env var.
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
    return `Set ${provider.apiKeyEnv} in .env to use ${modelName} via ${provider.name}.`
  }
  return `No credentials for ${provider.name}. Either set ${provider.apiKeyEnv ?? '<api-key-env>'} in .env or run \`typeclaw init\` and pick "OAuth".`
}
