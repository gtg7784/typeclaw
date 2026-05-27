import { KNOWN_PROVIDERS, type KnownProviderId } from '@/config/providers'

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
  | { kind: 'rejected'; status: number }

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

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
    headers['anthropic-version'] = '2023-06-01'
  }

  try {
    const res = await fetchImpl(probe.url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Probe URLs are hardcoded, but the provider could 3xx the response
      // mid-flight (CDN, regional bounce, captive portal). Auto-following
      // would send the credential to whatever Location said. Treat redirects
      // as "couldn't verify" instead.
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      return { kind: 'skipped', reason: 'network-error', detail: `HTTP ${res.status}` }
    }
    if (res.ok) {
      // A captive portal / WAF / corporate-MITM proxy can return HTTP 200
      // with an HTML login page in front of an unauthenticated request.
      // Treat the response as "ok" only if it parses as the expected
      // JSON shape (`{ data: [...] }` for /v1/models on every probed
      // provider).
      const shapeOk = await isModelsListShape(res)
      if (shapeOk) return { kind: 'ok' }
      return { kind: 'skipped', reason: 'network-error', detail: 'unexpected response shape' }
    }
    if (res.status === 401 || res.status === 403) {
      // Fireworks issues two key classes that probe the same /v1/models
      // endpoint differently:
      //   * Standard keys (fw_...)  → 200 with the models list
      //   * Fire Pass keys (fpk_...) → 403 with {"error":{"code":"FORBIDDEN",
      //     "message":"Fire Pass API keys are not authorized for this route."}}
      // The 403 *proves* authentication succeeded — the route is just out of
      // scope for the key. Fire Pass keys do work at chat-completions, which
      // is exactly the surface typeclaw needs (the only Fireworks model wired
      // here is the Fire Pass router `kimi-k2p6-turbo`). Treating that 403
      // as `rejected` is the bug; recognize the marker and accept the key.
      // Genuinely bad keys still come back as 401 UNAUTHORIZED, untouched.
      if (providerId === 'fireworks' && res.status === 403) {
        const body = await readCapped(res, MAX_BODY_BYTES)
        if (body !== null && isFireworksFirePassForbidden(body)) {
          return { kind: 'ok' }
        }
      }
      return { kind: 'rejected', status: res.status }
    }
    return { kind: 'skipped', reason: 'network-error', detail: `HTTP ${res.status}` }
  } catch (err) {
    return {
      kind: 'skipped',
      reason: 'network-error',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

const MAX_BODY_BYTES = 4096

function isFireworksFirePassForbidden(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } }
    const err = parsed.error
    if (!err || typeof err !== 'object') return false
    if (err.code === 'FORBIDDEN' && typeof err.message === 'string' && err.message.includes('Fire Pass')) {
      return true
    }
    return false
  } catch {
    return false
  }
}

async function isModelsListShape(res: Response): Promise<boolean> {
  const text = await readCapped(res, MAX_BODY_BYTES)
  if (text === null) return false
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { data?: unknown }).data)
  } catch {
    return false
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let read = 0
  try {
    while (read < maxBytes) {
      const { value, done } = await reader.read()
      if (done) break
      read += value.byteLength
      out += decoder.decode(value, { stream: true })
      if (read >= maxBytes) break
    }
    out += decoder.decode()
    return out
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export const API_KEY_DASHBOARD_URL: Partial<Record<KnownProviderId, string>> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  fireworks: 'https://fireworks.ai/account/api-keys',
  zai: 'https://docs.z.ai/devpack/tool/claude#api-key',
  'zai-coding': 'https://docs.z.ai/devpack/tool/claude#api-key',
}

export function providersWithApiKeyProbe(): KnownProviderId[] {
  return Object.keys(PROVIDER_PROBE) as KnownProviderId[]
}
