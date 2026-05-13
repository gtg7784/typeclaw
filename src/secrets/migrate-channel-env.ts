import { join } from 'node:path'

import { stripEnvKey } from './env'
import { migrateLegacyAuthJson } from './migrate'
import { SecretsBackend } from './storage'

// promoteChannelEnvIntoSecrets is the one-shot upgrade path for agents that
// pre-date the channel-tokens-in-secrets.json migration. For every (adapter,
// env-var) pair declared in CHANNEL_ENV_VARS, if the value is present in
// `process.env` but the corresponding slot in `secrets.json#channels` is
// missing, copy it into secrets.json AND strip the matching line from `.env`
// so secrets.json becomes the single source of truth in one atomic step:
//
//   pre-boot:      .env has {DISCORD_BOT_TOKEN=...}, secrets.json#channels={}
//   promote step:  .env no longer carries DISCORD_BOT_TOKEN,
//                  secrets.json#channels.discord-bot={DISCORD_BOT_TOKEN=...}
//   hydrate step:  process.env already populated for this boot (--env-file
//                  ran before promote), and on the NEXT boot hydrate is what
//                  injects the value from secrets.json into process.env.
//
// The `.env` strip is owned here, not in `hydrateChannelEnvFromSecrets`,
// because hydrate only knows about keys it `applied` (process.env was empty)
// — the migration case is exactly the opposite: process.env DOES have the
// value (it came from --env-file), so hydrate skips it and would leave the
// `.env` line dangling. Mirrors the api-key migration in `src/agent/auth.ts`,
// which strips `.env` at the same moment it writes to secrets.json.
//
// Only keys we actually wrote to secrets.json on THIS call are stripped — if
// the slot was already populated (manual edit wins, see test), `.env` stays
// untouched because no migration happened. Idempotent: re-running on an
// already-migrated agent promotes nothing and strips nothing.
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
    const envPath = join(options.agentDir, '.env')
    for (const keys of Object.values(promoted)) {
      for (const key of keys) {
        stripEnvKey(envPath, key)
      }
    }
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
