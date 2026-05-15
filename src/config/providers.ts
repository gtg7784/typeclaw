import type { Api, Model } from '@mariozechner/pi-ai'

// Authentication mechanism a provider supports. `api-key` reads a static key
// from .env (the original path); `oauth` runs a browser flow at init time and
// stores rotating credentials in secrets.json. The CLI picker uses this to ask
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
    // Costs and context windows mirror models.dev as of 2026-05-10. When
    // refreshing, also rerun `scripts/generate-schema.ts` so typeclaw.schema.json
    // picks up new enum values.
    models: {
      // Default. Cheapest tool-calling reasoning model in the family;
      // available on every paid OpenAI account tier.
      'gpt-5.4-nano': {
        id: 'gpt-5.4-nano',
        name: 'GPT-5.4 nano',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
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
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
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
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
        contextWindow: 1050000,
        maxTokens: 128000,
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        contextWindow: 1050000,
        maxTokens: 128000,
      },
    },
  },
  // ChatGPT Plus/Pro subscription via the OAuth Codex backend. No API key
  // path here on purpose — the Codex backend is OAuth-only upstream.
  //
  // pi-ai 0.73.1's `openai-codex` bucket carries gpt-5.5 (and 5.4) against
  // chatgpt.com/backend-api. We pin pi-coding-agent ^0.67.3 today, which
  // ships pi-ai 0.67.3 and lacks those entries — but we hand pi-ai a
  // freshly-constructed `Model<>` literal via resolveModel(), bypassing its
  // built-in catalog entirely (same trick we use for kimi-k2p6-turbo). So
  // these ids work end-to-end as long as the Codex backend itself accepts
  // them, which it does for ChatGPT Plus/Pro accounts as of 2026-05-10.
  'openai-codex': {
    id: 'openai-codex',
    name: 'OpenAI Codex (ChatGPT Plus/Pro)',
    baseUrl: 'https://chatgpt.com/backend-api',
    auth: ['oauth'],
    apiKeyEnv: null,
    oauthProviderId: 'openai-codex',
    models: {
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
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
  // Z.AI (ZhipuAI / BigModel) general pay-as-you-go API. OpenAI-compatible
  // (Bearer auth + /chat/completions shape), so models go through pi-ai's
  // `openai-completions` adapter with a custom baseUrl — same trick as
  // Fireworks. Costs and context windows mirror docs.z.ai/guides/overview/
  // pricing as of 2026-05-15.
  //
  // The split with `zai-coding` below mirrors how we model `openai` /
  // `openai-codex`: same upstream vendor, two distinct billing surfaces
  // (paygo vs subscription), two distinct base URLs, two distinct env vars
  // so a user can hold both keys simultaneously without collisions.
  zai: {
    id: 'zai',
    name: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    auth: ['api-key'],
    apiKeyEnv: 'ZAI_API_KEY',
    oauthProviderId: null,
    models: {
      'glm-4.5-air': {
        id: 'glm-4.5-air',
        name: 'GLM-4.5-Air',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.2, output: 1.1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 96000,
      },
      'glm-4.6': {
        id: 'glm-4.6',
        name: 'GLM-4.6',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
      'glm-4.7': {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
    },
  },
  // Z.AI GLM Coding Plan subscription. Same vendor, same key format, but a
  // distinct base URL (/api/coding/paas/v4) and a separate billing surface
  // — using a Coding Plan key against the paygo endpoint returns error 1113
  // ("insufficient balance"). Distinct env var (`ZAI_CODING_API_KEY`) so a
  // user can hold both a paygo and a Coding Plan key on different accounts.
  //
  // Model lineup is exactly the five models the Coding Plan docs name as
  // "All plans support" plus GLM-5 (Pro/Max only per docs). Listing other
  // GLM models here would silently bill against the wrong surface.
  'zai-coding': {
    id: 'zai-coding',
    name: 'Z.AI (GLM Coding Plan)',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    auth: ['api-key'],
    apiKeyEnv: 'ZAI_CODING_API_KEY',
    oauthProviderId: null,
    models: {
      'glm-4.5-air': {
        id: 'glm-4.5-air',
        name: 'GLM-4.5-Air',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.2, output: 1.1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 96000,
      },
      'glm-4.7': {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
      // GLM-5 access is Pro/Max tier only per docs.z.ai/devpack — Lite
      // subscribers will see a quota error. We still list it because we
      // can't introspect plan tier from the key alone.
      'glm-5': {
        id: 'glm-5',
        name: 'GLM-5',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        input: ['text'],
        cost: { input: 1.0, output: 3.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
      'glm-5-turbo': {
        id: 'glm-5-turbo',
        name: 'GLM-5-Turbo',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        input: ['text'],
        cost: { input: 1.2, output: 4.0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
      },
      'glm-5.1': {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        api: 'openai-completions',
        provider: 'zai-coding',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: true,
        input: ['text'],
        cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 128000,
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
