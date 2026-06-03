import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AdapterId } from '@/channels/schema'

import { restartHandoffPath } from './paths'

export { restartHandoffPath } from './paths'

export const RESTART_HANDOFF_TTL_MS = 60_000

// The channel coordinates needed to reopen and wake the originating session
// on the channel side after a restart. Mirrors ChannelKey (src/channels/types)
// but is duplicated here so the handoff module does not depend on the channel
// subsystem's full type surface — only the four routing coordinates travel in
// the handoff file.
export type RestartHandoffChannelKey = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

// Discriminates which subsystem owns resuming the originating session on boot.
// A TUI handoff is claimed by the websocket `open` handler (it needs a
// reconnecting client); a channel handoff is claimed by channel startup (the
// router reopens the session and wakes it without any client). Splitting the
// claim by kind is what stops the first TUI reconnect from deleting a
// channel-origin handoff before channel boot can see it.
export type RestartHandoffOrigin = { kind: 'tui' } | { kind: 'channel'; key: RestartHandoffChannelKey }

export type RestartHandoff = {
  schemaVersion: 2
  restartedAt: string
  originatingSessionId: string
  originatingSessionFile: string
  origin: RestartHandoffOrigin
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
// `accept` lets a caller claim only the handoffs it owns: the TUI path passes
// a tui-only predicate, channel boot passes a channel-only predicate. When the
// predicate REJECTS an otherwise-valid handoff, the file is restored so the
// rightful owner can still claim it (best-effort; a restore failure degrades
// to the same cold-start as a missing handoff). When `accept` is omitted, any
// valid handoff is consumed (preserves the original single-consumer behavior
// for callers that do not need kind-aware claiming).
//
// Returns the parsed handoff iff the file existed, was valid JSON of the
// expected shape, was within `ttlMs` of `now`, and (if `accept` is given)
// passed the predicate. Otherwise returns null. `now` and `ttlMs` are
// injectable so tests can drive the recency gate without sleeping.
export async function consumeRestartHandoff(
  agentDir: string,
  options: { now?: number; ttlMs?: number; accept?: (handoff: RestartHandoff) => boolean } = {},
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

  const handoff = parseHandoff(raw)

  // Peek before delete: a handoff we will NOT claim (malformed, expired, or
  // rejected by `accept`) is left untouched on disk so the rightful consumer
  // can still find it. The previous delete-then-restore opened a window where
  // a concurrent rightful consumer saw no file; never deleting an unclaimed
  // handoff closes that window entirely.
  if (handoff === null) {
    await rm(path, { force: true }).catch(() => undefined)
    return null
  }

  const restartedAtMs = Date.parse(handoff.restartedAt)
  if (Number.isNaN(restartedAtMs) || now - restartedAtMs > ttlMs) {
    await rm(path, { force: true }).catch(() => undefined)
    return null
  }

  if (options.accept !== undefined && !options.accept(handoff)) return null

  // Claim by deleting. A non-forced unlink distinguishes "we removed it" from
  // "it was already gone": if another consumer of the same kind claimed it
  // first, the unlink throws ENOENT and we return null, so the handoff is
  // honored exactly once even under concurrent same-kind consumers.
  try {
    await rm(path)
  } catch {
    return null
  }

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

  if (typeof obj.restartedAt !== 'string') return null
  if (typeof obj.originatingSessionId !== 'string' || obj.originatingSessionId === '') return null
  if (typeof obj.originatingSessionFile !== 'string' || obj.originatingSessionFile === '') return null

  // v1 handoffs predate the origin discriminator and were only ever written by
  // TUI sessions (channel/cron origins wrote no handoff). Read them forward as
  // a tui origin so an in-flight restart that straddles an upgrade still
  // produces the "I'm back" turn.
  if (obj.schemaVersion === 1) {
    return {
      schemaVersion: 2,
      restartedAt: obj.restartedAt,
      originatingSessionId: obj.originatingSessionId,
      originatingSessionFile: obj.originatingSessionFile,
      origin: { kind: 'tui' },
    }
  }

  if (obj.schemaVersion !== 2) return null
  const origin = parseOrigin(obj.origin)
  if (origin === null) return null
  return {
    schemaVersion: 2,
    restartedAt: obj.restartedAt,
    originatingSessionId: obj.originatingSessionId,
    originatingSessionFile: obj.originatingSessionFile,
    origin,
  }
}

function parseOrigin(raw: unknown): RestartHandoffOrigin | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.kind === 'tui') return { kind: 'tui' }
  if (obj.kind === 'channel') {
    const key = parseChannelKey(obj.key)
    if (key === null) return null
    return { kind: 'channel', key }
  }
  return null
}

function parseChannelKey(raw: unknown): RestartHandoffChannelKey | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.adapter !== 'string' || obj.adapter === '') return null
  if (typeof obj.workspace !== 'string') return null
  if (typeof obj.chat !== 'string') return null
  if (obj.thread !== null && typeof obj.thread !== 'string') return null
  return {
    adapter: obj.adapter as AdapterId,
    workspace: obj.workspace,
    chat: obj.chat,
    thread: obj.thread,
  }
}
