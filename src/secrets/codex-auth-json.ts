import type { ProviderCredential } from './schema'

// Emit the on-disk shape Codex CLI consumes at ~/.codex/auth.json. Mirrors
// the modern (>= 0.93) shape: a single `tokens` object with access_token,
// refresh_token, and optional account_id. Codex re-derives token expiry
// from the JWT's `exp` claim on every load, so we deliberately omit a
// top-level `expires` field even though typeclaw stores one.
//
// Pre-0.93 codex used a different layout (top-level OPENAI_API_KEY +
// auth_mode discriminator + optional tokens). We don't emit that legacy
// shape — every codex install old enough to require it has been replaced
// by the version `docker.file.codexCli` installs in the container.
export function emitCodexAuthJson(credential: ProviderCredential): string {
  if (credential.type !== 'oauth') {
    throw new Error('emitCodexAuthJson only accepts oauth-typed credentials')
  }
  const fields = credential as ProviderCredential & {
    access?: unknown
    refresh?: unknown
    accountId?: unknown
  }
  const access = fields.access
  const refresh = fields.refresh
  if (typeof access !== 'string' || access.length === 0) {
    throw new Error('credential is missing a non-empty `access` field')
  }
  if (typeof refresh !== 'string' || refresh.length === 0) {
    throw new Error('credential is missing a non-empty `refresh` field')
  }

  const tokens: Record<string, string> = { access_token: access, refresh_token: refresh }
  if (typeof fields.accountId === 'string' && fields.accountId.length > 0) {
    tokens['account_id'] = fields.accountId
  }
  return `${JSON.stringify({ tokens }, null, 2)}\n`
}

// Extracts the JWT `exp` claim (seconds since epoch) and converts to ms.
// Used by the runtime exporter's newer-wins compare: ~/.codex/auth.json
// carries no top-level expiry, but the JWT inside `tokens.access_token`
// does. Returns null on any decode failure; the caller treats that as
// "unknown freshness" and falls back to overwriting from typeclaw's copy.
export function decodeCodexAccessTokenExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split('.')
  if (parts.length !== 3) return null
  const middle = parts[1] ?? ''
  if (middle === '') return null
  // base64url → base64, then pad to a multiple of 4 (atob is strict).
  const normalized = middle.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  let payload: Record<string, unknown>
  try {
    const decoded = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)
    if (!isPlainObject(parsed)) return null
    payload = parsed
  } catch {
    return null
  }
  const exp = payload['exp']
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  return Math.floor(exp * 1000)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
