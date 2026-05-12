import { readFileSync, writeFileSync } from 'node:fs'

// No-op when the file is missing or the key is absent: the caller has
// already persisted to `secrets.json` and just wants `.env` to stop being a
// second source of truth. Parsing matches `parseEnvKeys` in
// `src/init/index.ts` — line-based, trim, skip blanks/comments, split on the
// first `=`. Duplicate assignments to the same key are all removed because
// dotenv resolves "last wins" so every duplicate carries the value we just
// promoted.
export function stripEnvKey(path: string, key: string): void {
  let original: string
  try {
    original = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const next = removeKeyFromEnvText(original, key)
  if (next === original) return
  writeFileSync(path, next)
}

export function removeKeyFromEnvText(content: string, key: string): string {
  const lines = content.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      kept.push(line)
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq <= 0) {
      kept.push(line)
      continue
    }
    const lineKey = trimmed.slice(0, eq).trim()
    if (lineKey === key) continue
    kept.push(line)
  }
  return kept.join('\n')
}
