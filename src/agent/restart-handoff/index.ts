import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { restartHandoffPath } from './paths'

export { restartHandoffPath } from './paths'

export const RESTART_HANDOFF_TTL_MS = 60_000

export type RestartHandoff = {
  schemaVersion: 1
  restartedAt: string
  originatingSessionId: string
  originatingSessionFile: string
}

// Atomic write via `.tmp` + rename so a crash mid-write never leaves the
// reader pointed at a partial JSON blob. The new container's consume() will
// either see the prior good file, the new good file, or nothing — never a
// half-written one. Errors are swallowed: handoff is best-effort. A failed
// write means the next boot cold-starts (no greeting), which is the same
// graceful degradation as the dying container being SIGKILL'd before the
// write could run.
export async function writeRestartHandoff(agentDir: string, handoff: RestartHandoff): Promise<void> {
  const path = restartHandoffPath(agentDir)
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(handoff), 'utf8')
    await rename(tmp, path)
  } catch {
    return
  }
}

// Read-and-delete in one call so the file is removed even if the caller
// rejects the contents (TTL expired, malformed JSON, wrong schemaVersion).
// Otherwise a stale file would linger until the NEXT restart wrote a fresh
// one, and the boot consumer would re-read the stale entry every time.
//
// Returns the parsed handoff iff the file existed, was valid JSON of the
// expected shape, and was within `ttlMs` of `now`. Otherwise returns null.
// `now` and `ttlMs` are injectable so tests can drive the recency gate
// without sleeping.
export async function consumeRestartHandoff(
  agentDir: string,
  options: { now?: number; ttlMs?: number } = {},
): Promise<RestartHandoff | null> {
  const path = restartHandoffPath(agentDir)
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? RESTART_HANDOFF_TTL_MS

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }

  await rm(path, { force: true }).catch(() => undefined)

  const handoff = parseHandoff(raw)
  if (handoff === null) return null

  const restartedAtMs = Date.parse(handoff.restartedAt)
  if (Number.isNaN(restartedAtMs)) return null
  if (now - restartedAtMs > ttlMs) return null

  return handoff
}

function parseHandoff(raw: string): RestartHandoff | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.schemaVersion !== 1) return null
  if (typeof obj.restartedAt !== 'string') return null
  if (typeof obj.originatingSessionId !== 'string' || obj.originatingSessionId === '') return null
  if (typeof obj.originatingSessionFile !== 'string' || obj.originatingSessionFile === '') return null
  return {
    schemaVersion: 1,
    restartedAt: obj.restartedAt,
    originatingSessionId: obj.originatingSessionId,
    originatingSessionFile: obj.originatingSessionFile,
  }
}
