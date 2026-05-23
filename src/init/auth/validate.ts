import { KNOWN_PROVIDERS, type KnownProviderId } from '@/config/providers'

// Probe URLs for "is this API key valid?" checks. Picked to be the cheapest
// authenticated GET each provider exposes — `/v1/models` returns a small
// JSON list and works under a plain `Authorization: Bearer <key>` for every
// OpenAI-compatible upstream we ship. Anthropic's `/v1/models` accepts
// `x-api-key`. Providers without a public probe URL are absent here and
// validation is skipped (the wizard accepts the key as-is, falling back to
// pre-existing behavior).
const PROVIDER_PROBE: Partial<Record<KnownProviderId, { url: string; authHeader: 'bearer' | 'x-api-key' }>> = {
  openai: { url: 'https://api.openai.com/v1/models', authHeader: 'bearer' },
  anthropic: { url: 'https://api.anthropic.com/v1/models', authHeader: 'x-api-key' },
  fireworks: { url: 'https://api.fireworks.ai/inference/v1/models', authHeader: 'bearer' },
  zai: { url: 'https://api.z.ai/api/paas/v4/models', authHeader: 'bearer' },
  'zai-coding': { url: 'https://api.z.ai/api/coding/paas/v4/models', authHeader: 'bearer' },
}

export type KeyValidationResult =
  | { kind: 'ok' }
  | { kind: 'skipped'; reason: 'no-probe' | 'network-error'; detail?: string }
  | { kind: 'rejected'; status: number; detail?: string }

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

// A 5s budget is enough for the cheapest endpoint on any well-connected
// provider and short enough that a non-dev user doesn't sit watching a
// spinner if their network is broken. We treat network errors as "skipped"
// rather than "rejected" so a flaky home connection doesn't block init.
const TIMEOUT_MS = 5_000

export async function validateApiKey(
  providerId: KnownProviderId,
  key: string,
  fetchImpl: FetchFn = fetch,
): Promise<KeyValidationResult> {
  const probe = PROVIDER_PROBE[providerId]
  if (!probe) return { kind: 'skipped', reason: 'no-probe' }
  const provider = KNOWN_PROVIDERS[providerId]
  if (!provider) return { kind: 'skipped', reason: 'no-probe' }

  const headers: Record<string, string> = {}
  if (probe.authHeader === 'bearer') {
    headers.Authorization = `Bearer ${key}`
  } else {
    headers['x-api-key'] = key
    // Anthropic requires this version header on every request; without it
    // /v1/models returns a 400, which would look like "key rejected".
    headers['anthropic-version'] = '2023-06-01'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(probe.url, { method: 'GET', headers, signal: controller.signal })
    if (res.ok) return { kind: 'ok' }
    if (res.status === 401 || res.status === 403) {
      return { kind: 'rejected', status: res.status, detail: await readErrorDetail(res) }
    }
    // Treat 4xx-other and 5xx as "skip" — the key might be fine, the
    // probe URL might just be down, or we're rate-limited. Don't block
    // the user on infrastructure flakiness.
    return { kind: 'skipped', reason: 'network-error', detail: `HTTP ${res.status}` }
  } catch (err) {
    return {
      kind: 'skipped',
      reason: 'network-error',
      detail: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const body = await res.text()
    if (body.length === 0) return undefined
    // Truncate so a misbehaving provider returning HTML doesn't dump an
    // entire page into the wizard.
    return body.length > 200 ? `${body.slice(0, 200)}...` : body
  } catch {
    return undefined
  }
}

// Provider-specific dashboard URL where the user can mint a key. Surfaced
// in the wizard's "paste your key" prompt so a non-dev knows where to go
// without leaving the terminal to read docs. Kept in sync with the provider
// table — every api-key provider gets one entry.
export const API_KEY_DASHBOARD_URL: Partial<Record<KnownProviderId, string>> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  fireworks: 'https://fireworks.ai/account/api-keys',
  zai: 'https://docs.z.ai/devpack/tool/claude#api-key',
  'zai-coding': 'https://docs.z.ai/devpack/tool/claude#api-key',
}
