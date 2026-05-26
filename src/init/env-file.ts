import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_FILE = '.env'

// Parse the agent's `.env` into a key-value map, matching Docker's
// `--env-file` parser semantics: blank lines and `#`-lines ignored, no
// quote stripping, no shell expansion, no whitespace trimming around `=`.
// Lines without `=` are skipped. Last value wins on duplicate keys.
export function readEnvFile(cwd: string): Map<string, string> {
  const out = new Map<string, string>()
  let raw: string
  try {
    raw = readFileSync(join(cwd, ENV_FILE), 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return out
    throw err
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue
    if (line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    out.set(key, value)
  }
  return out
}

export function hasEnvKey(cwd: string, key: string): boolean {
  const value = readEnvFile(cwd).get(key)
  return value !== undefined && value.length > 0
}

// Write `key=value` to the agent's `.env`. Idempotent: replaces an existing
// line for the same key in place (preserving order and surrounding comments),
// or appends if absent. Creates the file if missing. The value is written
// verbatim with no quoting because Docker's `--env-file` parser does not
// strip quotes (a wrapping `"..."` would land in `process.env` literally).
export function appendOrReplaceEnvKey(cwd: string, key: string, value: string): void {
  const path = join(cwd, ENV_FILE)
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') throw err
  }
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/)
  // `"foo\n".split(/\r?\n/)` returns `["foo", ""]` — strip that phantom
  // trailing empty element so the rebuilt output ends in exactly one newline
  // regardless of replace-vs-append path.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let replaced = false
  const next = lines.map((line) => {
    if (line.startsWith('#')) return line
    const eq = line.indexOf('=')
    if (eq <= 0) return line
    if (line.slice(0, eq) !== key) return line
    replaced = true
    return `${key}=${value}`
  })
  if (!replaced) next.push(`${key}=${value}`)
  const out = `${next.join('\n')}\n`
  writeFileSync(path, out, 'utf8')
}
