import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseMatchRule } from './match-rule'

// Appends `rule` to `typeclaw.json#roles.<name>.match`, creating the role
// block when missing. Idempotent: re-granting the same rule is a no-op.
// Atomic: writes via temp+rename so a crashed write never leaves a partial
// JSON file that would brick the next `typeclaw start`.
//
// Used by the role-claim flow (after a successful handshake) and by any
// future operator-direct grant command. The match rule is validated
// against the same parser that runs at config load, so a malformed rule
// fails here instead of bricking the next start.

const CONFIG_FILE = 'typeclaw.json'

export type GrantResult = { ok: true; added: boolean } | { ok: false; reason: string }

export type GrantOptions = {
  cwd: string
  roleName: string
  matchRule: string
}

export function grantRole(opts: GrantOptions): GrantResult {
  const validation = parseMatchRule(opts.matchRule)
  if (!validation.ok) {
    return { ok: false, reason: `invalid match rule '${opts.matchRule}': ${validation.error}` }
  }

  const path = join(opts.cwd, CONFIG_FILE)
  if (!existsSync(path)) {
    return { ok: false, reason: `${CONFIG_FILE} not found at ${opts.cwd}` }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, reason: `failed to read ${CONFIG_FILE}: ${describeError(error)}` }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `${CONFIG_FILE} is not valid JSON: ${describeError(error)}` }
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, reason: `${CONFIG_FILE} must be a JSON object` }
  }

  const obj = json as Record<string, unknown>
  const roles = isPlainObject(obj.roles) ? { ...obj.roles } : {}
  const role = isPlainObject(roles[opts.roleName]) ? { ...(roles[opts.roleName] as Record<string, unknown>) } : {}
  const existingMatch = Array.isArray(role.match) ? [...(role.match as unknown[])] : []

  // Dedup by exact string equality — match rules canonicalize during load,
  // and a literal duplicate in the file is a noise source the schema doesn't
  // currently dedupe for us.
  if (existingMatch.includes(opts.matchRule)) {
    return { ok: true, added: false }
  }

  role.match = [...existingMatch, opts.matchRule]
  roles[opts.roleName] = role
  obj.roles = roles

  try {
    writeAtomic(path, `${JSON.stringify(obj, null, 2)}\n`)
  } catch (error) {
    return { ok: false, reason: `failed to write ${CONFIG_FILE}: ${describeError(error)}` }
  }

  return { ok: true, added: true }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, content)
  try {
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw error
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
