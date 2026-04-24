import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'

type Auth = {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
}

let cached: Auth | null = null

export function getAuth(): Auth {
  if (cached) return cached

  const apiKey = process.env.FIREWORKS_API_KEY
  if (!apiKey) {
    console.error('Set FIREWORKS_API_KEY to use Kimi K2.6 Turbo via Fireworks.')
    process.exit(1)
  }

  const authStorage = AuthStorage.create()
  authStorage.setRuntimeApiKey('fireworks', apiKey)
  const modelRegistry = ModelRegistry.create(authStorage)

  cached = { authStorage, modelRegistry }
  return cached
}
