import type { KnownApi, Model } from '@mariozechner/pi-ai'

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
  models: Record<string, Model<KnownApi>>
}

// Curated provider + model table. Provider ids remain the allowlist for
// `typeclaw.json` refs, while the model entries are the tested defaults and
// JSON-schema autocomplete set. The init/model pickers may surface additional
// models from models.dev as long as the provider prefix is one of these ids.
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
//
// Granularity rule (split vs merge): a provider id is the runtime API surface,
// not the brand. Different API call => different provider id; same API call =>
// same provider id. "Same API call" means same endpoint + same wire transport.
// So `anthropic` is ONE id because api-key and oauth hit the same
// /v1/messages endpoint (only the auth header differs), while `openai` /
// `openai-codex` and `zai` / `zai-coding` are SEPARATE ids because each pair
// targets different endpoints (and env vars). The user-facing brand grouping
// lives in `KNOWN_PROVIDER_VENDORS` below — keep it out of this decision.
// Renaming an id is a breaking change to secrets.json keys and typeclaw.json
// model refs; only do it behind a migration in a dedicated major-version PR.
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
  //
  // Position-load-bearing: must stay adjacent to `openai`. `provider --help`'s
  // `id | id | ...` listing and the generated JSON schema's model-ref enum
  // derive their ordering from Object.keys() iteration on this literal, so
  // alphabetizing the registry would scatter `openai-codex` after `fireworks`.
  // (The init wizard's picker no longer depends on this order — it groups by
  // `KNOWN_PROVIDER_VENDORS` below.)
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
  // Anthropic Claude — both the Anthropic Console API (ANTHROPIC_API_KEY)
  // and Claude Pro/Max/Team/Enterprise subscriptions (OAuth) reach the same
  // /v1/messages endpoint and share one provider id. Auth path determines
  // which headers pi-ai's `anthropic-messages` transport injects: API key
  // sends a plain `x-api-key`; OAuth sends Bearer + Claude Code identity
  // (anthropic-beta: claude-code-20250219,oauth-2025-04-20 +
  // user-agent: claude-cli/<version>), which is exactly the surface a
  // subscriber's `claude setup-token` credential authorizes. The OAuth dance
  // itself is authorization-code + PKCE against `claude.ai/oauth/authorize`
  // with a localhost callback server (not device-code); the existing
  // `typeclaw-claude-code` skill documents the user-side flow for getting
  // a subscription credential onto the agent when the in-container browser
  // callback can't reach the user's machine.
  //
  // anthropic is the FIRST provider in the registry where both auth modes
  // coexist on one entry. The runtime in src/agent/auth.ts has a load-bearing
  // resolution rule: when secrets.json#providers.anthropic carries an OAuth
  // credential, `ANTHROPIC_API_KEY` in .env is IGNORED (OAuth-on-disk wins
  // because env-wins only applies to api-key-shaped credentials). For
  // api-key-only providers this is invisible; for anthropic it surfaces as
  // "I added the env var but the agent still uses OAuth." The mitigation is
  // to remove the OAuth credential explicitly (`typeclaw provider remove
  // anthropic`) before relying on the env-var path. Same rule applies to any
  // future dual-auth provider — keep the surprise in mind when expanding.
  //
  // Model lineup is the current GA tier as of 2026-05-29: Opus 4.8 (top,
  // released May 2026), Opus 4.7 (prior top, Apr 16 2026), Sonnet 4.6 (mid,
  // Feb 5 2026), Haiku 4.5 (fast, Oct 1 2025). Anthropic's own model overview
  // lists the latest Opus/Sonnet/Haiku as the current recommended set and
  // flags earlier Opus/Sonnet variants with
  // "Consider migrating to current models." Opus 4 / Sonnet 4 are deprecated
  // (retirement: Jun 15 2026); the 4.5/4.6 alternates remain Active but are
  // not the recommended path.
  //
  // ID semantics differ across the lineup and matter for forward-compat:
  //   - `claude-haiku-4-5` is a 4.5-generation CONVENIENCE ALIAS that
  //     resolves to the latest dated snapshot (currently `-20251001`). Per
  //     Anthropic's model-id docs, pre-4.6 dateless ids are evergreen
  //     pointers — Anthropic can ship a new dated snapshot under the same
  //     alias and we pick it up automatically.
  //   - `claude-sonnet-4-6` and `claude-opus-4-7` are 4.6+-generation PINNED
  //     SNAPSHOTS, not aliases. Anthropic explicitly says "the dateless ID is
  //     the canonical model ID for that release. It maps to a single, fixed
  //     model snapshot." A future Sonnet 4.6.1 (if it ever exists) would ship
  //     under a new id, NOT silently replace `claude-sonnet-4-6`.
  // Consequence for refresh discipline: bumping Haiku is a no-op (alias
  // catches the latest); bumping Sonnet/Opus to a future 4.7+ family is a
  // real edit here. Don't assume `claude-opus-4-7` will silently advance.
  //
  // Opus 4.7 specifics that affect cost accounting:
  //   - New tokenizer: same input maps to 1.0-1.3x more tokens than prior
  //     generations depending on content type. Per-token price is unchanged
  //     vs Opus 4.6, but total cost on identical workloads can rise meaningfully.
  //   - 1M token context window (vs 200k on Haiku) and 128k max output (vs
  //     64k on Sonnet/Haiku). 1M context is at standard pricing — no surcharge.
  //   - New `xhigh` effort level between `high` and `max` (pi-ai 0.67.x may
  //     not surface this knob yet; check before relying on it).
  //
  // Pricing mirrors Anthropic's official table as of 2026-05; cacheWrite is
  // the 5m-TTL rate (1.25x input). 1h TTL is ~2x input (not modeled here —
  // pi-ai's `cacheWrite` field captures the default 5m rate only).
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    auth: ['api-key', 'oauth'],
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    oauthProviderId: 'anthropic',
    models: {
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 1000000,
        maxTokens: 64000,
      },
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1000000,
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
  // xAI (Grok). The native developer API at api.x.ai/v1 is OpenAI-compatible
  // (Bearer auth + /chat/completions shape), so models go through pi-ai's
  // `openai-completions` adapter with a custom baseUrl — same trick as
  // Fireworks and Z.AI. This is a DUAL-AUTH provider like `anthropic`:
  //   * api-key — XAI_API_KEY (the standard xAI env var), a plain Bearer token.
  //   * oauth — Grok subscription login via xAI's OIDC server (auth.x.ai),
  //     authorization-code + PKCE. pi-ai ships no built-in xAI OAuth provider,
  //     so `oauthProviderId: 'xai'` resolves to the custom provider registered
  //     in src/secrets/oauth-xai.ts (registered from createSecretsStoreForAgent
  //     so both init-login and runtime-refresh see it). The dual-auth runtime
  //     rule in src/agent/auth.ts applies: an OAuth credential on disk wins over
  //     XAI_API_KEY in .env — remove it (`typeclaw provider remove xai`) to fall
  //     back to the key.
  //
  // Costs and context windows mirror docs.x.ai/developers/models and the raw
  // /v1/models price fields as of 2026-06-08 (xAI quotes prices in cents per
  // 100M tokens; e.g. grok-4.3 prompt 12500 = $1.25/1M). grok-4.3 is the
  // flagship default; grok-build-0.1 is the coding-tuned model. The
  // grok-4.20-0309 snapshots are pinned weights for reproducible runs.
  //
  // The earlier grok-4 / grok-4-fast / grok-code-fast-1 ids were RETIRED on
  // 2026-05-15 — they still resolve but silently redirect (and bill) at the
  // grok-4.3 / grok-build-0.1 rates, so they are intentionally NOT listed.
  //
  // cacheWrite is 0: xAI publishes no cache-write price (caching is implicit,
  // billed only at the cacheRead rate). Models 1-4 also carry a long-context
  // tier (2x rates above a 200k-token request); pi-ai's Model shape can't
  // express tiered pricing, so the standard rate is used and the breakpoint is
  // noted here. When refreshing, rerun `scripts/generate-schema.ts`.
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    auth: ['api-key', 'oauth'],
    apiKeyEnv: 'XAI_API_KEY',
    oauthProviderId: 'xai',
    models: {
      'grok-4.3': {
        id: 'grok-4.3',
        name: 'Grok 4.3',
        api: 'openai-completions',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 64000,
      },
      'grok-4.20-0309-reasoning': {
        id: 'grok-4.20-0309-reasoning',
        name: 'Grok 4.20 (Reasoning)',
        api: 'openai-completions',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 64000,
      },
      'grok-4.20-0309-non-reasoning': {
        id: 'grok-4.20-0309-non-reasoning',
        name: 'Grok 4.20 (Non-Reasoning)',
        api: 'openai-completions',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 64000,
      },
      'grok-build-0.1': {
        id: 'grok-build-0.1',
        name: 'Grok Build 0.1',
        api: 'openai-completions',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.0, output: 2.0, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
    },
  },
  // MiniMax (minimax.io) pay-as-you-go API. OpenAI-compatible (Bearer auth +
  // /chat/completions shape), so models go through pi-ai's `openai-completions`
  // adapter with a custom baseUrl — same trick as Fireworks and Z.AI.
  //
  // Endpoint choice: the international endpoint (api.minimax.io) is the global
  // surface; the China endpoint (api.minimaxi.com) is a regional alternative on
  // the same protocol. We pin the international one here — operators who need the
  // China gateway can front it with an OpenAI-compatible proxy.
  //
  // Model lineup mirrors the OpenAI-compatible model enum on
  // platform.minimax.io as of 2026-06-08: MiniMax-M3 (flagship, 1M context,
  // image input, controllable reasoning) plus the M2 reasoning series
  // (204,800 context, reasoning always on, text-only). The `-highspeed`
  // billing-tier variants and the native-only `M2-her` / `MiniMax-Text-01` /
  // `abab*` models are intentionally omitted — the first are duplicate weights
  // on a pricier surface, the rest don't serve the OpenAI-compatible
  // /chat/completions route this adapter speaks. Costs are USD per 1M tokens
  // from docs/guides/pricing-paygo (standard tier): M3 reflects the permanent
  // 50%-off ≤512K-input rate (input 0.30 / output 1.20 / cacheRead 0.06; M3 has
  // no separate cache-write rate). M2.7 caches at 0.06 read / 0.375 write; the
  // M2.5/M2.1/M2 series at 0.03 read / 0.375 write.
  //
  // M3 tiered pricing is NOT modeled: this single cost record only encodes the
  // ≤512K-input tier. The >512K tier (input 0.60 / output 2.40 / cacheRead 0.12)
  // is a limited-availability surcharge that pi-ai's flat per-model cost shape
  // can't represent, so long-context M3 sessions above 512K under-report cost.
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    auth: ['api-key'],
    apiKeyEnv: 'MINIMAX_API_KEY',
    oauthProviderId: null,
    models: {
      'MiniMax-M3': {
        id: 'MiniMax-M3',
        name: 'MiniMax M3',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 524288,
      },
      'MiniMax-M2.7': {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 204800,
      },
      'MiniMax-M2.5': {
        id: 'MiniMax-M2.5',
        name: 'MiniMax M2.5',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 204800,
      },
      'MiniMax-M2.1': {
        id: 'MiniMax-M2.1',
        name: 'MiniMax M2.1',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 204800,
      },
      'MiniMax-M2': {
        id: 'MiniMax-M2',
        name: 'MiniMax M2',
        api: 'openai-completions',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
        contextWindow: 204800,
        maxTokens: 204800,
      },
    },
  },
  // DeepSeek (api.deepseek.com) pay-as-you-go API. OpenAI-compatible (Bearer
  // auth + /chat/completions shape), so models go through pi-ai's
  // `openai-completions` adapter with a custom baseUrl — same trick as
  // Fireworks, Z.AI, and MiniMax. api-key only; DeepSeek ships no OAuth flow.
  //
  // baseUrl is bare `https://api.deepseek.com` (no `/v1` segment) — the SDK
  // appends `/chat/completions`. This mirrors Anthropic's no-`/v1` convention,
  // not the OpenAI/xAI `/v1` one; `validate-api-key.ts` probes
  // `${baseUrl}/models` accordingly.
  //
  // Model lineup is the V4 generation as listed on api-docs.deepseek.com/quick_start/pricing
  // as of 2026-06-08: deepseek-v4-flash (fast, cheap default) and
  // deepseek-v4-pro (stronger). Both default to thinking/reasoning mode (it is
  // toggleable upstream, but reasoning: true reflects the default). 1M context,
  // 384K max output, text-only — DeepSeek's API exposes no image input. The
  // legacy `deepseek-chat` / `deepseek-reasoner` aliases (deprecated 2026-07-24,
  // they redirect into v4-flash's non-thinking/thinking modes) are intentionally
  // omitted in favor of the canonical v4 ids.
  //
  // Costs are USD per 1M tokens (standard tier). DeepSeek prices input on a
  // cache-miss/cache-hit split: `input` is the cache-miss rate, `cacheRead` is
  // the cache-hit rate. There is no published cache-write surcharge, so
  // cacheWrite is 0.
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    auth: ['api-key'],
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    oauthProviderId: null,
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        api: 'openai-completions',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
      },
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        api: 'openai-completions',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
      },
    },
  },
  // Moonshot AI (Kimi) — Open Platform pay-as-you-go API. The platform exposes
  // an OpenAI-compatible surface at api.moonshot.ai/v1 (Bearer auth +
  // /chat/completions shape), so models go through pi-ai's `openai-completions`
  // adapter with a custom baseUrl — same trick as Fireworks, Z.AI, MiniMax, and
  // DeepSeek. api-key only; the platform ships no OAuth flow.
  //
  // Moonshot also offers an Anthropic-compatible route (api.moonshot.ai/anthropic)
  // on the same key, but it rescales temperature (real = requested × 0.6) and
  // would be the FIRST `anthropic-messages` transport pointed at a non-Anthropic
  // baseUrl in this codebase. We deliberately stay on the proven OpenAI-compatible
  // path so behavior matches every other paygo provider.
  //
  // The split with `moonshot-coding` below mirrors `zai` / `zai-coding`: same
  // upstream vendor, two distinct billing surfaces (Open Platform paygo vs the
  // Kimi Code subscription) on two distinct base URLs with two distinct env
  // vars, so a user can hold both keys at once. The Open Platform key does NOT
  // work against the Kimi Code endpoint, and vice versa.
  //
  // Model lineup mirrors the OpenAI-compatible model list on platform.kimi.ai
  // as of 2026-06-14: kimi-k2.7-code (flagship coding model, always-on thinking,
  // text+image), kimi-k2.6 (general flagship, text+image), and kimi-k2.5
  // (general, text+image). All three fold reasoning in via the `thinking`
  // request parameter, so no separate "thinking" model id is needed. The whole
  // legacy kimi-k2 series (kimi-k2-thinking, k2-0905/0711/turbo previews) was
  // officially discontinued on 2026-05-25 and is intentionally omitted, as are
  // the legacy moonshot-v1-* models. Costs are USD per 1M tokens from
  // platform.kimi.ai pricing; Moonshot publishes no cache-write surcharge, so
  // cacheWrite is 0. (pi-ai's `input` array only models text/image — Moonshot's
  // video input on the K2.x models can't be expressed here, so it is omitted.)
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    auth: ['api-key'],
    apiKeyEnv: 'MOONSHOT_API_KEY',
    oauthProviderId: null,
    models: {
      'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        api: 'openai-completions',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
      'kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        api: 'openai-completions',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
      'kimi-k2.5': {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        api: 'openai-completions',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.ai/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
    },
  },
  // Moonshot AI Kimi Code — the Coding Plan subscription product. Distinct from
  // the Open Platform above: a separate domain (api.kimi.com/coding/v1), a
  // separate subscription key created at kimi.com/code/console, and a separate
  // env var (`MOONSHOT_CODING_API_KEY`) so a user can hold both an Open Platform
  // paygo key and a Coding Plan key without collisions. Kimi Code exposes an
  // OpenAI-compatible route (Bearer auth + /chat/completions) alongside its
  // Anthropic-compatible one; we use the OpenAI-compatible route so it threads
  // through the same `openai-completions` adapter as every other paygo provider.
  //
  // Single model alias: `kimi-for-coding` is a STABLE ALIAS that the Coding Plan
  // backend routes to the latest underlying model (currently the K2.6 family).
  // Version-pinned ids are NOT accepted on this endpoint and fail silently, so
  // the alias is the only id listed. Costs are 0 because the Coding Plan bills a
  // flat subscription quota, not per-token — there is no per-token price to
  // attribute (same convention as the Fireworks Fire Pass router above).
  'moonshot-coding': {
    id: 'moonshot-coding',
    name: 'Moonshot (Kimi Coding Plan)',
    baseUrl: 'https://api.kimi.com/coding/v1',
    auth: ['api-key'],
    apiKeyEnv: 'MOONSHOT_CODING_API_KEY',
    oauthProviderId: null,
    models: {
      'kimi-for-coding': {
        id: 'kimi-for-coding',
        name: 'Kimi for Coding',
        api: 'openai-completions',
        provider: 'moonshot-coding',
        baseUrl: 'https://api.kimi.com/coding/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 64000,
      },
    },
  },
} as const satisfies Record<string, KnownProvider>

export type KnownProviderId = keyof typeof KNOWN_PROVIDERS

// UX-only grouping of provider ids under one vendor for the init/`provider
// add` pickers. Deliberately does NOT touch the runtime contract:
// `KnownProviderId`, `KnownModelRef`, secrets.json keys, auth resolution, and
// the generated schema all stay keyed on the flat ids in `KNOWN_PROVIDERS`.
// The follow-up "variant" prompt resolves a concrete provider id, then
// `pickAuthMethod` runs as before; it is auto-resolved for single-provider
// vendors (Fireworks, Anthropic). `variants` copy lets the prompt read as an
// auth choice for OpenAI but a plan choice for Z.AI (both api-key, different
// billing surfaces).
type KnownProviderVendor = {
  id: string
  name: string
  providers: ReadonlyArray<KnownProviderId>
  variants?: Partial<Record<KnownProviderId, { label: string; hint?: string }>>
}

// Ordered by product priority for the picker — independent of the
// `KNOWN_PROVIDERS` declaration order (which stays load-bearing for the schema
// enum and `provider --help` listing). Every provider id below MUST appear in
// exactly one vendor; `providers.test.ts` enforces the partition.
export const KNOWN_PROVIDER_VENDORS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    providers: ['openai', 'openai-codex'],
    variants: {
      openai: { label: 'API key', hint: 'OpenAI API platform' },
      'openai-codex': { label: 'OAuth (ChatGPT Plus/Pro)', hint: 'ChatGPT subscription' },
    },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    providers: ['anthropic'],
  },
  fireworks: {
    id: 'fireworks',
    name: 'Fireworks',
    providers: ['fireworks'],
  },
  zai: {
    id: 'zai',
    name: 'Z.AI',
    providers: ['zai', 'zai-coding'],
    variants: {
      zai: { label: 'Pay-as-you-go', hint: 'standard API billing' },
      'zai-coding': { label: 'Coding Plan', hint: 'GLM Coding Plan subscription' },
    },
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    providers: ['xai'],
  },
  // Single-provider vendor: pay-as-you-go and Token Plan are the SAME provider
  // id (same /v1 endpoint, same Bearer transport — only the key prefix differs),
  // so per the granularity rule above MiniMax is one id like Anthropic, not a
  // zai-style split. The picker shows one row and skips the variant prompt; the
  // pay-as-you-go-vs-Token-Plan dashboard hint is handled in the key-entry step.
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    providers: ['minimax'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    providers: ['deepseek'],
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    providers: ['moonshot', 'moonshot-coding'],
    variants: {
      moonshot: { label: 'Pay-as-you-go', hint: 'Moonshot Open Platform API billing' },
      'moonshot-coding': { label: 'Coding Plan', hint: 'Kimi Code subscription' },
    },
  },
} as const satisfies Record<string, KnownProviderVendor>

export type KnownProviderVendorId = keyof typeof KNOWN_PROVIDER_VENDORS

export function listKnownProviderVendorIds(): KnownProviderVendorId[] {
  return Object.keys(KNOWN_PROVIDER_VENDORS) as KnownProviderVendorId[]
}

export function providerIdsForVendor(vendorId: KnownProviderVendorId): ReadonlyArray<KnownProviderId> {
  return KNOWN_PROVIDER_VENDORS[vendorId].providers
}

export function vendorForProviderId(providerId: KnownProviderId): KnownProviderVendorId {
  for (const vendorId of listKnownProviderVendorIds()) {
    if ((KNOWN_PROVIDER_VENDORS[vendorId].providers as ReadonlyArray<KnownProviderId>).includes(providerId)) {
      return vendorId
    }
  }
  throw new Error(`Provider ${providerId} is not assigned to any vendor in KNOWN_PROVIDER_VENDORS`)
}

function variantCopy(
  vendorId: KnownProviderVendorId,
  providerId: KnownProviderId,
): { label: string; hint?: string } | undefined {
  const vendor: KnownProviderVendor = KNOWN_PROVIDER_VENDORS[vendorId]
  return vendor.variants?.[providerId]
}

// Falls back to the provider's own name when a vendor supplies no variant copy
// (single-provider vendors never render this prompt, so the fallback only
// guards against an incomplete `variants` map on a multi-provider vendor).
export function variantLabel(vendorId: KnownProviderVendorId, providerId: KnownProviderId): string {
  return variantCopy(vendorId, providerId)?.label ?? KNOWN_PROVIDERS[providerId].name
}

export function variantHint(vendorId: KnownProviderVendorId, providerId: KnownProviderId): string | undefined {
  return variantCopy(vendorId, providerId)?.hint
}

export type KnownModelRef = {
  [P in KnownProviderId]: `${P}/${Extract<keyof (typeof KNOWN_PROVIDERS)[P]['models'], string>}`
}[KnownProviderId]

export type ModelRef = string & { readonly __modelRef: unique symbol }

export function listKnownModelRefs(): KnownModelRef[] {
  const refs: string[] = []
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    for (const modelId of Object.keys(KNOWN_PROVIDERS[providerId].models)) {
      refs.push(`${providerId}/${modelId}`)
    }
  }
  return refs as KnownModelRef[]
}

export function isKnownModelRef(value: string): value is KnownModelRef {
  return (listKnownModelRefs() as ReadonlyArray<string>).includes(value)
}

export function isModelRef(value: string): value is ModelRef {
  return /^[a-z0-9][a-z0-9-]*\/[^\s/][^\s]*$/.test(value) && knownProviderForModelRef(value) !== null
}

// The default we hand to scaffolded `typeclaw.json` and the schema's
// `model.default`. Lives here (next to the provider table) so adding a model
// can't drift from the field default — both come from the same module.
export const DEFAULT_MODEL_REF: KnownModelRef = 'openai/gpt-5.4-nano'

export function providerForModelRef(ref: KnownModelRef | ModelRef | string): KnownProviderId {
  // KnownModelRef is `${provider}/${modelId}`, but provider IDs themselves can
  // contain '-' and model IDs can contain '/' (Fireworks). We split on the
  // first slash that follows a registered provider id.
  const providerId = knownProviderForModelRef(ref)
  if (providerId !== null) return providerId
  throw new Error(`Unknown provider in model ref: ${ref}`)
}

function knownProviderForModelRef(ref: string): KnownProviderId | null {
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    if (ref.startsWith(`${providerId}/`)) return providerId
  }
  return null
}

// Per-provider default for pi-coding-agent's `thinkingLevel` knob. Returning
// `undefined` defers to the SDK default (`medium`); returning a level pins it
// to that value at session-creation time.
//
// OpenAI-family providers (`openai`, `openai-codex`) pin to `low`: GPT-5.x at
// `medium` pads reasoning tokens on routine tool-driven turns (code edits,
// channel replies, cron prompts) with no observable quality delta on this
// codebase's workloads. Applies to every session that resolves to a GPT model
// regardless of profile, so the saving is uniform.
//
// Anthropic, GLM, and Kimi don't share the padding behavior, so they keep the
// SDK default.
export function isOpenAiFamilyRef(ref: KnownModelRef | ModelRef | string): boolean {
  return vendorForProviderId(providerForModelRef(ref)) === 'openai'
}

export function defaultThinkingLevelForRef(ref: KnownModelRef | ModelRef | string): 'low' | undefined {
  if (isOpenAiFamilyRef(ref)) return 'low'
  return undefined
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
