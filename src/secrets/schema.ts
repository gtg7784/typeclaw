import { z } from 'zod'

import { CHANNEL_ENV_TO_FIELD } from './defaults'
import { secretFieldSchema, type Secret } from './resolve'

// providers.<id> for api-key credentials: the `key` field is a Secret (string
// shorthand or `{ value?, env? }` object). resolveSecret turns this into a
// flat string at read time so AuthStorage (which expects `key: string`)
// stays happy. OAuth credentials carry stateful refresh/access tokens that
// are not env-injectable, so they pass through unchanged via catchall.
const apiKeyProviderSchema = z.object({
  type: z.literal('api_key'),
  key: secretFieldSchema,
})

const oauthProviderSchema = z
  .object({
    type: z.literal('oauth'),
  })
  .catchall(z.unknown())

export const providerCredentialSchema = z.discriminatedUnion('type', [apiKeyProviderSchema, oauthProviderSchema])

export const providersSchema = z.record(z.string(), providerCredentialSchema)

// Per-adapter channel slots use named fields (`botToken`, `appToken`, `token`)
// instead of env-var-name keys. The Secret union per field carries the env-var
// override. Unknown adapter ids pass through via catchall so a future
// plugin-contributed adapter doesn't fail validation.
const slackBotChannelSchema = z.object({
  botToken: secretFieldSchema.optional(),
  appToken: secretFieldSchema.optional(),
})

const discordBotChannelSchema = z.object({
  token: secretFieldSchema.optional(),
})

const telegramBotChannelSchema = z.object({
  token: secretFieldSchema.optional(),
})

const githubPatAuthSchema = z.object({
  type: z.literal('pat'),
  token: secretFieldSchema,
})

const githubAppAuthSchema = z.object({
  type: z.literal('app'),
  appId: z.number().int().positive(),
  privateKey: secretFieldSchema,
  installationId: z.number().int().positive().optional(),
})

const githubChannelSchema = z.object({
  auth: z.discriminatedUnion('type', [githubPatAuthSchema, githubAppAuthSchema]),
  webhookSecret: secretFieldSchema,
})

// Encrypted password envelope produced by src/secrets/encryption.ts. Optional
// in the schema because legacy v2 accounts (pre-renewal feature) don't have
// one; the renewal cron treats a missing envelope as "reauth required" and
// degrades to logged warnings rather than crashing.
const kakaoEncryptedPasswordSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal('AES-256-GCM'),
    kid: z.string(),
    iv: z.string(),
    ciphertext: z.string(),
    authTag: z.string(),
    createdAt: z.string(),
  })
  .strict()

export const kakaoAccountRecordSchema = z.object({
  account_id: z.string(),
  oauth_token: z.string(),
  user_id: z.string(),
  refresh_token: z.string().optional(),
  device_uuid: z.string(),
  device_type: z.union([z.literal('pc'), z.literal('tablet')]),
  auth_method: z.union([z.literal('login'), z.literal('extract')]).optional(),
  created_at: z.string(),
  updated_at: z.string(),
  // Renewal-feature additions. Both optional to preserve compatibility with
  // legacy accounts; renewal degrades to "reauth required" when either is
  // absent. See src/secrets/kakao-renewal.ts.
  email: z.string().optional(),
  encryptedPassword: kakaoEncryptedPasswordSchema.optional(),
})

export type KakaoEncryptedPassword = z.infer<typeof kakaoEncryptedPasswordSchema>

export const kakaoPendingLoginRecordSchema = z.object({
  device_uuid: z.string(),
  device_type: z.union([z.literal('pc'), z.literal('tablet')]),
  email: z.string(),
  created_at: z.string(),
})

export const kakaoChannelBlockSchema = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.record(z.string(), kakaoAccountRecordSchema),
  pendingLogin: kakaoPendingLoginRecordSchema.optional(),
})

export const channelsSchema = z
  .object({
    'slack-bot': slackBotChannelSchema.optional(),
    'discord-bot': discordBotChannelSchema.optional(),
    github: githubChannelSchema.optional(),
    'telegram-bot': telegramBotChannelSchema.optional(),
    kakaotalk: kakaoChannelBlockSchema.optional(),
  })
  .catchall(z.unknown())

// version 2 = providers.* with Secret-typed api-key.key + per-adapter
// channel field shapes. version 1 = the previous shape (flat `llm.*`, channel
// slots keyed by env-var name). Legacy v1 input is upgraded transparently by
// parseSecretsFile; the first write persists v2.
export const SECRETS_FILE_VERSION = 2

export const secretsFileSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(SECRETS_FILE_VERSION),
  providers: providersSchema.default({}),
  channels: channelsSchema.default({}),
})

export type ProviderCredential = z.infer<typeof providerCredentialSchema>
export type Providers = z.infer<typeof providersSchema>
export type Channels = z.infer<typeof channelsSchema>
export type GithubPatAuthBlock = z.infer<typeof githubPatAuthSchema>
export type GithubAppAuthBlock = z.infer<typeof githubAppAuthSchema>
export type GithubSecretsBlock = z.infer<typeof githubChannelSchema>
export type KakaoAccountRecord = z.infer<typeof kakaoAccountRecordSchema>
export type PendingLoginRecord = z.infer<typeof kakaoPendingLoginRecordSchema>
export type KakaoChannelBlock = z.infer<typeof kakaoChannelBlockSchema>
export type SecretsFile = z.infer<typeof secretsFileSchema>

export type ParseSecretsResult = { ok: true; file: SecretsFile } | { ok: false; reason: string }

// parseSecretsFile recognises three shapes, in priority order:
//   1. The v2 envelope (current): { version: 2, providers, channels }
//   2. The v1 envelope (legacy): { version: 1, llm, channels } where channel
//      slots are keyed by env-var name. Both `llm` and `channels` get
//      reshaped — llm -> providers, env-keyed channel slots -> field-keyed.
//   3. The pre-envelope flat shape (very legacy): Record<string, AuthCredential>
//      at top level. Treated as { version: 2, providers: <flat>, channels: {} }
//      so existing OAuth users transparently upgrade.
//
// Every legacy upgrade produces a v2-shaped SecretsFile in memory; the next
// write persists v2 to disk. The legacy branches stay forever as a quiet
// compatibility seam — only the v2 form is documented.
export function parseSecretsFile(raw: unknown): ParseSecretsResult {
  const v2 = secretsFileSchema.safeParse(raw)
  if (v2.success) return { ok: true, file: v2.data }

  const v1 = legacyV1Schema.safeParse(raw)
  if (v1.success) return { ok: true, file: upgradeV1ToV2(v1.data) }

  const flat = legacyFlatProviderSchema.safeParse(raw)
  if (flat.success) {
    return { ok: true, file: upgradeV1ToV2({ version: 1, llm: flat.data, channels: {} }) }
  }

  return { ok: false, reason: v2.error.issues.map(formatIssue).join('; ') }
}

// Legacy v1 schema: `llm` (flat string-key) and `channels` (env-var-keyed
// flat map per adapter). Used only for upgrade reads; never written.
const legacyV1ApiKeySchema = z.object({
  type: z.literal('api_key'),
  key: z.string().min(1),
})

const legacyV1OAuthSchema = z
  .object({
    type: z.literal('oauth'),
  })
  .catchall(z.unknown())

const legacyV1CredentialSchema = z.discriminatedUnion('type', [legacyV1ApiKeySchema, legacyV1OAuthSchema])

const legacyV1LlmSchema = z.record(z.string(), legacyV1CredentialSchema)

const legacyV1ChannelsSchema = z.record(z.string(), z.record(z.string(), z.string()))

const legacyV1Schema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  llm: legacyV1LlmSchema.default({}),
  channels: legacyV1ChannelsSchema.default({}),
})

const legacyFlatProviderSchema = z.record(z.string(), legacyV1CredentialSchema)

function upgradeV1ToV2(legacy: z.infer<typeof legacyV1Schema>): SecretsFile {
  const providers: Providers = {}
  for (const [providerId, cred] of Object.entries(legacy.llm)) {
    if (cred.type === 'api_key') {
      providers[providerId] = { type: 'api_key', key: { value: cred.key } }
    } else {
      providers[providerId] = cred
    }
  }

  const channels: Channels = {}
  for (const [adapterId, envKeyedSlot] of Object.entries(legacy.channels)) {
    const upgradedSlot: Record<string, Secret> = {}
    for (const [envKey, value] of Object.entries(envKeyedSlot)) {
      const mapping = CHANNEL_ENV_TO_FIELD[envKey]
      if (mapping && mapping.adapterId === adapterId) {
        upgradedSlot[mapping.fieldName] = { value }
      } else {
        // Unknown env-var-name key on a known adapter, or an adapter we don't
        // recognise: pass through verbatim under the original key. Better to
        // preserve user data than drop it; the catchall on channelsSchema
        // makes this safe.
        upgradedSlot[envKey] = { value }
      }
    }
    channels[adapterId] = upgradedSlot
  }

  const result: SecretsFile = {
    version: SECRETS_FILE_VERSION,
    providers,
    channels,
  }
  if (legacy.$schema !== undefined) result.$schema = legacy.$schema
  return result
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
