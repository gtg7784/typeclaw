import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'

type Auth = {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
}

const TEST_DUMMY_API_KEY = 'fw_test_dummy'

let cached: Auth | null = null

export function getAuth(): Auth {
  if (cached) return cached

  // Bun sets NODE_ENV=test automatically under `bun test`. Use a dummy key
  // there so suites that build sessions but never hit the LLM don't need real
  // credentials; production still hard-exits to surface misconfiguration.
  const apiKey = process.env.FIREWORKS_API_KEY ?? (process.env.NODE_ENV === 'test' ? TEST_DUMMY_API_KEY : undefined)
  if (!apiKey) {
    console.error('Set FIREWORKS_API_KEY to use Kimi K2.5 Turbo via Fireworks.')
    process.exit(1)
  }

  const authStorage = AuthStorage.create()
  authStorage.setRuntimeApiKey('fireworks', apiKey)
  const modelRegistry = ModelRegistry.create(authStorage)

  cached = { authStorage, modelRegistry }
  return cached
}

export function resetAuthForTesting(): void {
  cached = null
}
