import type { ProviderCredential } from './schema'

// Emit the on-disk shape Claude Code consumes at ~/.claude/.credentials.json
// (Linux/Windows; macOS keeps this same JSON inside the Keychain entry
// "Claude Code-credentials"). The single required top-level key is
// `claudeAiOauth`. Field names use camelCase, not snake_case — diverging
// from Codex CLI's `tokens.access_token` shape but matching every
// third-party Claude Code integration we surveyed (ATLAS_OS, OmniRoute,
// jcode, paperclip, opencode-claude-auth).
//
// `expiresAt` is MILLISECONDS since epoch, not seconds and not ISO. The
// CLI carries no top-level expiry field outside `claudeAiOauth` — token
// expiry is recorded both as `expiresAt` here and embedded in the JWT
// `exp` claim of `accessToken`. The runtime exporter (export-claude-
// credentials-file.ts) uses the JWT exp for its newer-wins compare,
// mirroring the Codex CLI exporter's approach, because `expiresAt` is
// the field Claude Code itself rewrites on in-place refresh.
//
// `mcpOAuth` (MCP server OAuth state) may coexist alongside
// `claudeAiOauth` in the same file. This emitter accepts an optional
// `preserveMcpOAuth` block so callers that read-merge-write the file
// don't drop unrelated state. Codex CLI's file is fully owned by the
// OAuth credential and has no equivalent; this is the one extra
// complication versus emitCodexAuthJson.
export type ClaudeAiOauthBlock = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string
}

export type EmitClaudeCredentialsJsonOptions = {
  preserveMcpOAuth?: unknown
}

export function emitClaudeCredentialsJson(
  credential: ProviderCredential,
  options: EmitClaudeCredentialsJsonOptions = {},
): string {
  if (credential.type !== 'oauth') {
    throw new Error('emitClaudeCredentialsJson only accepts oauth-typed credentials')
  }
  const fields = credential as ProviderCredential & {
    access?: unknown
    refresh?: unknown
    expires?: unknown
    scopes?: unknown
    subscriptionType?: unknown
  }
  const access = fields.access
  const refresh = fields.refresh
  if (typeof access !== 'string' || access.length === 0) {
    throw new Error('credential is missing a non-empty `access` field')
  }
  if (typeof refresh !== 'string' || refresh.length === 0) {
    throw new Error('credential is missing a non-empty `refresh` field')
  }

  // Resolution order for `expiresAt`:
  //   1. `expires` on the credential (pi-ai writes absolute ms epoch here).
  //   2. JWT `exp` claim decoded from `access`.
  //   3. 0 — Claude Code treats a missing/zero expiry as "expired" and
  //      triggers an immediate refresh on next use, which is the safe
  //      fallback when neither source is available.
  const expiresAt = readExpiryMs(fields, access)

  const claudeAiOauth: ClaudeAiOauthBlock = {
    accessToken: access,
    refreshToken: refresh,
    expiresAt,
  }
  if (Array.isArray(fields.scopes) && fields.scopes.every((s): s is string => typeof s === 'string')) {
    claudeAiOauth.scopes = fields.scopes
  }
  if (typeof fields.subscriptionType === 'string' && fields.subscriptionType.length > 0) {
    claudeAiOauth.subscriptionType = fields.subscriptionType
  }

  // Read-merge-write: preserve any existing `mcpOAuth` block the caller
  // supplied. The emitter doesn't read disk itself (that's the exporter's
  // job); the caller passes whatever it found at the existing file path.
  const out: Record<string, unknown> = { claudeAiOauth }
  if (options.preserveMcpOAuth !== undefined) {
    out['mcpOAuth'] = options.preserveMcpOAuth
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

// Extracts the JWT `exp` claim (seconds since epoch) and converts to ms.
// Used by the runtime exporter's newer-wins compare and by emit's
// `expiresAt` fallback. Returns null on any decode failure; the caller
// treats that as "unknown freshness". Logic mirrors
// decodeCodexAccessTokenExpiryMs verbatim — Claude Code OAuth access
// tokens are standard JWTs with the same base64url-encoded payload
// shape Codex uses.
export function decodeClaudeAccessTokenExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split('.')
  if (parts.length !== 3) return null
  const middle = parts[1] ?? ''
  if (middle === '') return null
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

function readExpiryMs(fields: { expires?: unknown }, accessToken: string): number {
  if (typeof fields.expires === 'number' && Number.isFinite(fields.expires)) {
    return fields.expires
  }
  const fromJwt = decodeClaudeAccessTokenExpiryMs(accessToken)
  if (fromJwt !== null) return fromJwt
  return 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
