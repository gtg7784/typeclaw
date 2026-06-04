import { z } from 'zod'

import { secretFieldSchema } from './resolve'

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
// channel field shapes.
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

// parseSecretsFile accepts only the current v2 envelope:
// { version: 2, providers, channels }.
export function parseSecretsFile(raw: unknown): ParseSecretsResult {
  const v2 = secretsFileSchema.safeParse(raw)
  if (v2.success) return { ok: true, file: v2.data }

  return { ok: false, reason: v2.error.issues.map(formatIssue).join('; ') }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
