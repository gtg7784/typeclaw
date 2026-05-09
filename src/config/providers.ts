import type { Model } from '@mariozechner/pi-ai'

type KnownProvider = {
  id: string
  name: string
  baseUrl: string
  apiKeyEnv: string
  models: Record<string, Model<'openai-completions'> | Model<'openai-responses'>>
}

// Curated allowlist of providers + models that are wired into the agent
// runtime. The values here back the Zod enum on `configSchema.model`, so any
// model the user can put in `typeclaw.json` MUST appear here verbatim. The
// init-time picker may surface additional models from models.dev, but it
// resolves them through this list before scaffolding (anything missing falls
// back to a curated default).
//
// Adding a new model: append it to the matching provider's `models` map. Each
// model object is the literal `Model<...>` that pi-ai consumes — keep it
// faithful to https://github.com/mariozechner/pi-ai (the readme's "Custom
// Models" section). `setRuntimeApiKey(provider, key)` keys off the `provider`
// field, so it MUST match the outer provider id.
//
// Adding a new provider: add a top-level entry. `apiKeyEnv` is the .env var
// `typeclaw init` writes and `agent/auth.ts` reads at boot, so make it
// match the upstream provider's standard env var (e.g. `OPENAI_API_KEY`).
export const KNOWN_PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    // OpenAI's library auto-detects this from `provider: 'openai'`, but we
    // store it explicitly so the init wizard can show users which endpoint
    // their key will hit.
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: {
      // Default. Cheap, fast, broadly available across OpenAI account tiers.
      'gpt-5.4-nano': {
        id: 'gpt-5.4-nano',
        name: 'GPT-5.4 nano',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      },
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
        contextWindow: 1050000,
        maxTokens: 128000,
      },
    },
  },
  fireworks: {
    id: 'fireworks',
    name: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    models: {
      // Kept available even though models.dev hasn't indexed it yet —
      // Fireworks ships this router as an alias to the latest k2.6 weights.
      'accounts/fireworks/routers/kimi-k2p6-turbo': {
        id: 'accounts/fireworks/routers/kimi-k2p6-turbo',
        name: 'Kimi K2.6 Turbo',
        api: 'openai-completions',
        provider: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 256000,
      },
    },
  },
} as const satisfies Record<string, KnownProvider>

export type KnownProviderId = keyof typeof KNOWN_PROVIDERS

export type KnownModelRef = {
  [P in KnownProviderId]: `${P}/${Extract<keyof (typeof KNOWN_PROVIDERS)[P]['models'], string>}`
}[KnownProviderId]

export function listKnownModelRefs(): KnownModelRef[] {
  const refs: string[] = []
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    for (const modelId of Object.keys(KNOWN_PROVIDERS[providerId].models)) {
      refs.push(`${providerId}/${modelId}`)
    }
  }
  return refs as KnownModelRef[]
}

// The default we hand to scaffolded `typeclaw.json` and the schema's
// `model.default`. Lives here (next to the provider table) so adding a model
// can't drift from the field default — both come from the same module.
export const DEFAULT_MODEL_REF: KnownModelRef = 'openai/gpt-5.4-nano'

export function providerForModelRef(ref: KnownModelRef): KnownProviderId {
  // KnownModelRef is `${provider}/${modelId}`, but model IDs themselves can
  // contain '/' (Fireworks), so split on the FIRST slash only.
  const slash = ref.indexOf('/')
  return ref.slice(0, slash) as KnownProviderId
}
