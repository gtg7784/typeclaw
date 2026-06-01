import type { Api, Model } from '@mariozechner/pi-ai'

import { providerForModelRef, type KnownModelRef } from '@/config/providers'

// Matches the Anthropic SDK's own `ANTHROPIC_BASE_URL` so a working
// credential/endpoint pair carries over. Scope is a base-URL swap only: it
// targets Anthropic-compatible gateways (LiteLLM, Cloudflare AI Gateway,
// corporate proxies) speaking native `/v1/messages` with `x-api-key`/OAuth
// Bearer — NOT raw AWS Bedrock, which needs SigV4 and a different transport.
export const ANTHROPIC_BASE_URL_ENV = 'ANTHROPIC_BASE_URL'

// Separate from `resolveModel` so resolution stays a pure table lookup; this
// is the per-process "prepare the model" seam run just before pi-coding-agent
// receives it. Clones because the `KNOWN_PROVIDERS` literals are shared static
// data that must never be mutated.
export function applyModelRuntimeOverrides<TApi extends Api>(
  model: Model<TApi>,
  ref: KnownModelRef,
  env: NodeJS.ProcessEnv = process.env,
): Model<TApi> {
  if (providerForModelRef(ref) !== 'anthropic') return model

  const baseUrl = normalizeBaseUrl(env[ANTHROPIC_BASE_URL_ENV])
  if (baseUrl === undefined) return model

  return { ...model, baseUrl }
}

// Resolves the effective Anthropic base URL for a process, falling back to the
// provider default when the override is unset. Used by callers outside the
// session path (e.g. the init-time API-key probe) that need to hit the same
// endpoint the runtime will use.
export function effectiveAnthropicBaseUrl(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBaseUrl(env[ANTHROPIC_BASE_URL_ENV]) ?? fallback
}

// `undefined` for unset/blank (caller keeps the default); throws on a value
// that isn't a parseable http(s) URL so a typo fails loudly at boot rather
// than silently falling back to api.anthropic.com with the wrong credential.
function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return undefined

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${ANTHROPIC_BASE_URL_ENV} is not a valid URL: ${trimmed}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${ANTHROPIC_BASE_URL_ENV} must use http:// or https://, got: ${trimmed}`)
  }
  return url.toString().replace(/\/+$/, '')
}
