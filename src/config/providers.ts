import type { Api, Model } from '@mariozechner/pi-ai'

// Authentication mechanism a provider supports. `api-key` reads a static key
// from .env (the original path); `oauth` runs a browser flow at init time and
// stores rotating credentials in auth.json. The CLI picker uses this to ask
// "API key or OAuth?" only when both are wired up.
export type AuthMethod = 'api-key' | 'oauth'

// `apiKeyEnv` and `oauthProviderId` are both always present on the literal
// to keep `as const satisfies` narrowing easy on the consumer side; entries
// that don't apply to a given provider are set to `null` rather than omitted.
// Consumers check `auth.includes('api-key')` / `auth.includes('oauth')` to
// decide which field to consult.
type KnownProvider = {
  id: string
  name: string
  baseUrl: string
  auth: ReadonlyArray<AuthMethod>
  apiKeyEnv: string | null
  oauthProviderId: string | null
  models: Record<string, Model<Api>>
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
// Adding a new provider: add a top-level entry. Set `auth` to the supported
// methods. For `api-key` providers, `apiKeyEnv` is the .env var typeclaw
// writes at init and reads at boot (match the upstream provider's standard,
// e.g. `OPENAI_API_KEY`). For `oauth` providers, `oauthProviderId` MUST match
// a pi-ai OAuth provider id exactly, otherwise `authStorage.login()` will
// throw "Unknown OAuth provider".
export const KNOWN_PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    // OpenAI's library auto-detects this from `provider: 'openai'`, but we
    // store it explicitly so the init wizard can show users which endpoint
    // their key will hit.
    baseUrl: 'https://api.openai.com/v1',
    auth: ['api-key'],
    apiKeyEnv: 'OPENAI_API_KEY',
    oauthProviderId: null,
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
  // ChatGPT Plus/Pro subscription via the OAuth Codex backend. No API key
  // path here on purpose — the Codex backend is OAuth-only upstream.
  'openai-codex': {
    id: 'openai-codex',
    name: 'OpenAI Codex (ChatGPT Plus/Pro)',
    baseUrl: 'https://chatgpt.com/backend-api',
    auth: ['oauth'],
    apiKeyEnv: null,
    oauthProviderId: 'openai-codex',
    models: {
      'gpt-5.2-codex': {
        id: 'gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
      'gpt-5.1-codex-max': {
        id: 'gpt-5.1-codex-max',
        name: 'GPT-5.1 Codex Max',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
      'gpt-5.1-codex-mini': {
        id: 'gpt-5.1-codex-mini',
        name: 'GPT-5.1 Codex Mini',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
    },
  },
  fireworks: {
    id: 'fireworks',
    name: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    auth: ['api-key'],
    apiKeyEnv: 'FIREWORKS_API_KEY',
    oauthProviderId: null,
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
  // KnownModelRef is `${provider}/${modelId}`, but provider IDs themselves can
  // contain '-' and model IDs can contain '/' (Fireworks). We split on the
  // first slash that follows a registered provider id.
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    if (ref.startsWith(`${providerId}/`)) return providerId
  }
  throw new Error(`Unknown provider in model ref: ${ref}`)
}

// `as const satisfies` narrows each entry's `auth` to a tuple of its specific
// literal values, which makes `provider.auth.includes('oauth')` fail to
// compile on api-key-only entries (because TS thinks the array can never
// contain 'oauth'). These accessors widen the membership check back to
// AuthMethod so consumers can branch without per-provider casts.
export function supportsApiKey(provider: { auth: ReadonlyArray<AuthMethod> }): boolean {
  return (provider.auth as ReadonlyArray<AuthMethod>).includes('api-key')
}

export function supportsOAuth(provider: { auth: ReadonlyArray<AuthMethod> }): boolean {
  return (provider.auth as ReadonlyArray<AuthMethod>).includes('oauth')
}
