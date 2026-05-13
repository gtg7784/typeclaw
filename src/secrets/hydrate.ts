import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { stripEnvKey } from './env'
import { parseSecretsFile } from './schema'

// hydrateChannelEnvFromSecrets makes secrets.json the source of truth for
// channel adapter tokens while keeping the runtime's env-var contract
// (`src/channels/manager.ts` reads `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`,
// etc. from `process.env`). The flow at container boot:
//
//   1. Read secrets.json#channels — a per-adapter map of env-var-name → value.
//   2. For each (key, value) pair where `process.env[key]` is not already set,
//      set it.
//   3. If `.env` carries a duplicate of a value we just promoted from
//      secrets.json, strip it from `.env` so the user has a single place to
//      rotate. This mirrors the api-key migration in `src/agent/auth.ts`:
//      secrets.json wins, `.env` becomes a one-way write channel for
//      pre-secrets.json values that get migrated in.
//
// Conflict policy: if BOTH process.env (from `--env-file .env`) AND
// secrets.json#channels carry a value for the same key, env wins. Same
// rationale as `agent/auth.ts`'s "never overwrite OAuth with .env" rule —
// hot-loaded env via `docker run --env-file` is the operator's explicit
// override, and we don't want secrets.json to silently displace it. The
// stripEnvKey step still runs after promotion so the file form stops being a
// second source of truth post-migration.
//
// One-shot migration (pre-secrets.json agents): if a channel env-var key
// exists in `process.env` but NOT in `secrets.json#channels`, the caller is
// responsible for promoting it into secrets.json. That promotion lives in
// `src/secrets/migrate-channel-env.ts`, not here — this helper only handles
// the secrets.json → process.env direction so it stays trivially testable.
//
// Errors are non-fatal: a missing or malformed `secrets.json` returns an
// empty result rather than throwing, so an agent that hasn't run init yet
// can still boot (its channel adapters just won't start, same as today).
export function hydrateChannelEnvFromSecrets(options: { agentDir: string; env?: NodeJS.ProcessEnv }): {
  applied: string[]
  skipped: string[]
} {
  const env = options.env ?? process.env
  const secretsPath = join(options.agentDir, 'secrets.json')
  const channels = readChannelSecrets(secretsPath)

  const applied: string[] = []
  const skipped: string[] = []
  const envPath = join(options.agentDir, '.env')

  for (const [, tokens] of Object.entries(channels)) {
    if (tokens === undefined) continue
    for (const [key, value] of Object.entries(tokens)) {
      if (env[key] !== undefined && env[key] !== '') {
        skipped.push(key)
        continue
      }
      env[key] = value
      applied.push(key)
    }
  }

  for (const key of applied) {
    stripEnvKey(envPath, key)
  }

  return { applied, skipped }
}

type ChannelSlot = Record<string, string>

function readChannelSecrets(secretsPath: string): Record<string, ChannelSlot | undefined> {
  let raw: string
  try {
    raw = readFileSync(secretsPath, 'utf8')
  } catch {
    return {}
  }
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const result = parseSecretsFile(parsed)
  if (!result.ok) return {}
  const channels = result.file.channels as Record<string, unknown>
  const out: Record<string, ChannelSlot | undefined> = {}
  for (const [adapterId, slot] of Object.entries(channels)) {
    if (!isStringRecord(slot)) continue
    out[adapterId] = slot
  }
  return out
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false
  }
  return true
}
