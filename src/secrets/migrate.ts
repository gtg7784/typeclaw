import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { parseSecretsFile } from './schema'

const LEGACY_FILENAME = 'auth.json'
const TARGET_FILENAME = 'secrets.json'

// One-shot rename of an old agent folder's auth.json to secrets.json. Called
// from createSecretsStoreForAgent before the backend opens the file so the
// rest of the storage pipeline only ever sees secrets.json. The rename runs
// on every store construction because it's cheap (existsSync + early return
// in the common case) and the rename itself is the state — no flag file.
//
// Cases:
//   1. only auth.json exists  -> renameSync to secrets.json
//   2. only secrets.json      -> no-op
//   3. neither                -> no-op (backend will seed secrets.json)
//   4. both exist, auth.json is the empty seed envelope -> unlink auth.json
//   5. both exist, both non-empty -> throw, refuse to merge
//
// The "both non-empty" hard error matters: if a user copied an old agent
// folder, edited auth.json by hand, AND a newer typeclaw later created
// secrets.json, we don't know which is the source of truth. Loud failure
// beats silent merge.
export function migrateLegacyAuthJson(agentDir: string): void {
  const legacyPath = join(agentDir, LEGACY_FILENAME)
  const targetPath = join(agentDir, TARGET_FILENAME)

  if (!existsSync(legacyPath)) return

  if (!existsSync(targetPath)) {
    renameSync(legacyPath, targetPath)
    return
  }

  if (isEmptyEnvelope(legacyPath)) {
    unlinkSync(legacyPath)
    return
  }

  throw new Error(
    `Both ${LEGACY_FILENAME} and a non-empty ${TARGET_FILENAME} exist in ${agentDir}. ` +
      `Inspect manually and remove the stale file before re-running.`,
  )
}

// "Empty envelope" = no actual credentials. Parsed shape with empty llm and
// empty channels. We do NOT try to be clever about "approximately empty" —
// exact emptiness is the only safe auto-delete case.
function isEmptyEnvelope(path: string): boolean {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  if (raw.trim() === '') return true

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }

  const result = parseSecretsFile(parsed)
  if (!result.ok) return false
  return Object.keys(result.file.llm).length === 0 && Object.keys(result.file.channels).length === 0
}
