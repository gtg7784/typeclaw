import { KNOWN_PROVIDERS, type KnownProviderId } from '@/config/providers'

// DEFAULT_ENV_NAMES is the single source of truth for the env-var name each
// secret-bearing field uses when the user does not override it via the `env`
// field of a `Secret` object. Two layers depend on it:
//
//   1. resolveSecret (src/secrets/resolve.ts) — when the on-disk Secret has
//      no explicit `env`, it falls back to this table to know which env var
//      to consult for env-wins resolution.
//   2. hydrateChannelEnvFromSecrets (src/secrets/hydrate.ts) — when injecting
//      resolved channel field values into `process.env`, it uses these names
//      so that `src/channels/manager.ts` (which reads `env.DISCORD_BOT_TOKEN`
//      etc. directly) keeps working without per-adapter refactoring.
// Providers come from `KNOWN_PROVIDERS[id].apiKeyEnv` — derived, not duplicated.
// OAuth-only providers are intentionally absent: OAuth credentials are not
// env-injectable (refresh tokens are stateful).

export const CHANNEL_FIELD_ENV = {
  'discord-bot': { token: 'DISCORD_BOT_TOKEN' },
  'slack-bot': { botToken: 'SLACK_BOT_TOKEN', appToken: 'SLACK_APP_TOKEN' },
  'telegram-bot': { token: 'TELEGRAM_BOT_TOKEN' },
  'webex-bot': { token: 'WEBEX_BOT_TOKEN' },
} as const satisfies Record<string, Record<string, string>>

export type KnownAdapterId = keyof typeof CHANNEL_FIELD_ENV

export function isKnownAdapterId(id: string): id is KnownAdapterId {
  return id in CHANNEL_FIELD_ENV
}

// Returns the default env-var name for a known channel field, or undefined
// when the adapter or field is not in CHANNEL_FIELD_ENV (forward-compat: a
// future adapter contributed via plugin would not appear in this table).
export function channelFieldDefaultEnv(adapterId: string, fieldName: string): string | undefined {
  if (!isKnownAdapterId(adapterId)) return undefined
  const adapterFields = CHANNEL_FIELD_ENV[adapterId] as Record<string, string>
  return adapterFields[fieldName]
}

// Returns the canonical env-var name for an api-key provider, or undefined
// when the provider is OAuth-only (apiKeyEnv === null in KNOWN_PROVIDERS).
// OAuth-only providers never participate in env-wins resolution.
export function providerKeyDefaultEnv(providerId: string): string | undefined {
  const provider = (KNOWN_PROVIDERS as Record<string, { apiKeyEnv: string | null }>)[providerId]
  if (!provider) return undefined
  return provider.apiKeyEnv ?? undefined
}

export function isKnownProviderId(id: string): id is KnownProviderId {
  return id in KNOWN_PROVIDERS
}
