import { join } from 'node:path'

import { migrateLegacyAuthJson } from './migrate'
import { SecretsBackend } from './storage'

// promoteChannelEnvIntoSecrets is the one-shot upgrade path for agents that
// pre-date the channel-tokens-in-secrets.json migration. For every (adapter,
// env-var) pair declared in CHANNEL_ENV_VARS, if the value is present in
// `process.env` but the corresponding slot in `secrets.json#channels` is
// missing, copy it into secrets.json. The `.env` strip is owned by
// `hydrateChannelEnvFromSecrets`, called immediately after this in the boot
// sequence, so the two phases together form the full migration:
//
//   pre-boot:      .env has {DISCORD_BOT_TOKEN=...}, secrets.json#channels={}
//   promote step:  .env unchanged, secrets.json#channels.discord-bot={DISCORD_BOT_TOKEN=...}
//   hydrate step:  process.env populated from secrets.json (no-op when env
//                  already has the value via --env-file), .env stripped.
//
// Idempotent: the promotion only fires when the secrets.json slot is empty,
// so re-running on an already-migrated agent does nothing. Running on every
// boot is intentional — no flag file needed.
export const CHANNEL_ENV_VARS: Record<string, readonly string[]> = {
  'discord-bot': ['DISCORD_BOT_TOKEN'],
  'slack-bot': ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  'telegram-bot': ['TELEGRAM_BOT_TOKEN'],
}

export function promoteChannelEnvIntoSecrets(options: { agentDir: string; env?: NodeJS.ProcessEnv }): {
  promoted: Record<string, string[]>
} {
  const env = options.env ?? process.env
  const promoted: Record<string, string[]> = {}

  const pending: Array<{ adapterId: string; key: string; value: string }> = []
  for (const [adapterId, keys] of Object.entries(CHANNEL_ENV_VARS)) {
    for (const key of keys) {
      const value = env[key]
      if (value === undefined || value === '') continue
      pending.push({ adapterId, key, value })
    }
  }
  if (pending.length === 0) return { promoted }

  const secretsPath = join(options.agentDir, 'secrets.json')
  migrateLegacyAuthJson(options.agentDir)
  const backend = new SecretsBackend(secretsPath)
  const channels = { ...backend.readChannelsSync() }

  for (const { adapterId, key, value } of pending) {
    const existing = channels[adapterId]
    const slot = isStringRecord(existing) ? { ...existing } : {}
    if (slot[key] !== undefined) continue
    slot[key] = value
    channels[adapterId] = slot
    ;(promoted[adapterId] ??= []).push(key)
  }

  if (Object.keys(promoted).length > 0) {
    backend.writeChannelsSync(channels)
  }
  return { promoted }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false
  }
  return true
}
