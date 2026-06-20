import type { ProviderCredential } from './schema'

// Emit the on-disk shape Codex CLI consumes at ~/.codex/auth.json: a `tokens`
// object with id_token, access_token, refresh_token, and optional account_id.
// No top-level `expires` — codex re-derives expiry from the JWT `exp` claim.
//
// id_token is load-bearing: codex's deserializer (token_data.rs) declares
// `id_token: IdTokenInfo` with no Option/#[serde(default)], so omitting it
// fails the whole auth.json load with `missing field id_token` before any
// model call. codex parses it via `parse_chatgpt_jwt_claims`, which accepts
// any decodable 3-part JWT and treats every claim as optional.
//
// We prefer a real captured id_token (`idToken`/`id_token` on the credential,
// e.g. from a future pi-ai that persists it) and fall back to `access`. The
// fallback is sound because this flow's access token is itself a ChatGPT-claims
// JWT (carries `https://api.openai.com/auth`), so codex reads the same
// plan/account fields from it — self-healing agents whose stored credential
// predates id_token capture, without a re-login.
export function emitCodexAuthJson(credential: ProviderCredential): string {
  if (credential.type !== 'oauth') {
    throw new Error('emitCodexAuthJson only accepts oauth-typed credentials')
  }
  const fields = credential as ProviderCredential & {
    access?: unknown
    refresh?: unknown
    accountId?: unknown
    idToken?: unknown
    id_token?: unknown
  }
  const access = fields.access
  const refresh = fields.refresh
  if (typeof access !== 'string' || access.length === 0) {
    throw new Error('credential is missing a non-empty `access` field')
  }
  if (typeof refresh !== 'string' || refresh.length === 0) {
    throw new Error('credential is missing a non-empty `refresh` field')
  }

  const capturedIdToken = firstNonEmptyString(fields.idToken, fields.id_token)
  const idToken = capturedIdToken ?? access

  const tokens: Record<string, string> = {
    id_token: idToken,
    access_token: access,
    refresh_token: refresh,
  }
  if (typeof fields.accountId === 'string' && fields.accountId.length > 0) {
    tokens['account_id'] = fields.accountId
  }
  return `${JSON.stringify({ tokens }, null, 2)}\n`
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

// Extracts the JWT `exp` claim (seconds since epoch) and converts to ms.
// Used by the runtime exporter's newer-wins compare: ~/.codex/auth.json
// carries no top-level expiry, but the JWT inside `tokens.access_token`
// does. Returns null on any decode failure; the caller treats that as
// "unknown freshness" and falls back to overwriting from typeclaw's copy.
export function decodeCodexAccessTokenExpiryMs(accessToken: string): number | null {
  const payload = decodeJwtPayload(accessToken)
  if (payload === null) return null
  const exp = payload['exp']
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  return Math.floor(exp * 1000)
}

// True when the string decodes the way codex's `decode_jwt_payload` requires:
// three non-empty dot-separated parts with a base64url payload that is a JSON
// object. codex runs exactly this on `tokens.id_token` (via
// `parse_chatgpt_jwt_claims`) and rejects the whole auth.json if it fails, so
// the exporter uses this to decide whether an on-disk id_token is usable —
// not just non-empty.
export function isDecodableJwt(token: string): boolean {
  return decodeJwtPayload(token) !== null
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const middle = parts[1] ?? ''
  if (middle === '') return null
  // base64url → base64, then pad to a multiple of 4 (atob is strict).
  const normalized = middle.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const decoded = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
