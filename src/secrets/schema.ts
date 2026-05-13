import { z } from 'zod'

// The api_key shape exactly matches pi-coding-agent's ApiKeyCredential. We
// re-state it here (rather than import the upstream type into the schema)
// because Zod schemas are the source of truth for validation and JSON Schema
// generation, and pi-coding-agent does not export Zod schemas.
const llmApiKeyCredentialSchema = z.object({
  type: z.literal('api_key'),
  key: z.string().min(1),
})

// pi-coding-agent's OAuth credential carries provider-specific fields
// (access, refresh, expires, plus arbitrary upstream additions). We accept
// them as a passthrough object so future upstream additions don't break parse.
// Upstream is the runtime authority on OAuth shape; our job here is only to
// route the slice safely through the file envelope.
const llmOAuthCredentialSchema = z
  .object({
    type: z.literal('oauth'),
  })
  .catchall(z.unknown())

export const llmCredentialSchema = z.discriminatedUnion('type', [llmApiKeyCredentialSchema, llmOAuthCredentialSchema])

// Map keyed by provider id ("openai", "openai-codex", "fireworks", ...).
// Exactly the shape pi-coding-agent persists today as the entire secrets file.
export const llmCredentialsSchema = z.record(z.string(), llmCredentialSchema)

// Each adapter's slot is a flat map of env-var name -> secret value. The
// runtime hydrates `process.env` from this map at boot (see
// `hydrateChannelEnvFromSecrets` in `src/secrets/hydrate.ts`), so adding a new
// secret env var to an adapter requires no schema change here — the catchall
// on the value type accepts arbitrary keys. The OUTER catchall (`z.record`
// catchall) keeps forward compatibility when a future TypeClaw writes
// additional adapter ids the current version doesn't know about.
//
// Why a string→string map and not a typed `{ token, appToken }` shape per
// adapter: the on-disk file mirrors the env-var contract the manager already
// honors (TOKEN_ENV in `src/channels/manager.ts`). Keeping the shape
// schema-mirrored to env keys means the manager doesn't need a per-adapter
// translation layer — hydration is `for (const [k, v] of entries) env[k] = v`.
const channelTokenMapSchema = z.record(z.string(), z.string())

const knownAdapterIds = ['discord-bot', 'slack-bot', 'telegram-bot'] as const

export const channelsSchema = z
  .object(Object.fromEntries(knownAdapterIds.map((id) => [id, channelTokenMapSchema.optional()])))
  .catchall(z.unknown())

export const secretsFileSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  llm: llmCredentialsSchema.default({}),
  channels: channelsSchema.default({}),
})

export type LlmCredential = z.infer<typeof llmCredentialSchema>
export type LlmCredentials = z.infer<typeof llmCredentialsSchema>
export type SecretsFile = z.infer<typeof secretsFileSchema>

export type ParseSecretsResult = { ok: true; file: SecretsFile } | { ok: false; reason: string }

// parseSecretsFile recognises two shapes:
//   1. The new envelope: { version: 1, llm: {...}, channels: {...} }
//   2. The legacy flat shape pi-coding-agent writes today: a top-level
//      Record<string, AuthCredential>. Treated as { version: 1, llm: <flat>,
//      channels: {} } so existing OAuth users transparently upgrade on the
//      next write that goes through this code path.
//
// An empty object {} is a legitimate legacy state — a freshly-created
// secrets file with no providers logged in yet. It upgrades cleanly to the
// new envelope with empty llm and channels.
export function parseSecretsFile(raw: unknown): ParseSecretsResult {
  const direct = secretsFileSchema.safeParse(raw)
  if (direct.success) return { ok: true, file: direct.data }

  const legacy = llmCredentialsSchema.safeParse(raw)
  if (legacy.success) {
    return { ok: true, file: { version: 1, llm: legacy.data, channels: {} } }
  }

  // Neither shape matched. We surface the new-shape error because that's the
  // target the user is presumably moving toward; the legacy path is a quiet
  // compatibility seam, not a documented format.
  return { ok: false, reason: direct.error.issues.map(formatIssue).join('; ') }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
