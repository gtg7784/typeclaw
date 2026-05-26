import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DREAMING_STATE_FILE = 'memory/.dreaming-state.json'

const VERSION = 2

// Stat-keyed cache for `.dreaming-state.json`. The file is read once at
// the start of every dreaming run AND once per `readAllStreamDays` call
// (which fires inside every `memory_search` invocation). For a retrieval
// subagent that issues 3 parallel searches, this cache turns 3 reads +
// 3 JSON.parses into 3 stats + 1 parse — small per-call savings, but the
// file is tiny so the win is mostly avoiding GC pressure on busy
// channel sessions. Invalidation key matches the stream-file cache
// (`load-shards.ts` and `stream-io.ts` use the same `(mtimeMs, ctimeMs,
// size)` shape); `saveDreamingState` uses `writeFile` which bumps both
// mtime and ctime.
type DreamingStateCacheEntry = {
  mtimeMs: number
  ctimeMs: number
  size: number
  state: DreamingState
}
const dreamingStateCache = new Map<string, DreamingStateCacheEntry>()

// Per-day "dreamed" set: the set of stream-event ids dreaming has already
// reasoned over for a given day. Anything in this set is either cited from
// memory/topics/ (must survive compaction) or was consciously discarded by a
// dreaming run (safe to GC). The undreamed-tail computation is set
// difference: events whose id is NOT in this set are the new things to look
// at on the next run.
//
// Tracking ids (not line numbers) is the load-bearing invariant for fragment
// compaction — line numbers shift when any earlier event is removed, ids
// don't.
export type DreamingState = {
  version: number
  dreamedThrough: Record<string, DreamedDay>
}

export type DreamedDay = {
  dreamedIds: string[]
  ts: string
}

export function emptyState(): DreamingState {
  return { version: VERSION, dreamedThrough: {} }
}

export async function loadDreamingState(agentDir: string): Promise<DreamingState> {
  const path = join(agentDir, DREAMING_STATE_FILE)
  if (!existsSync(path)) {
    dreamingStateCache.delete(path)
    return emptyState()
  }

  let fileStat: { mtimeMs: number; ctimeMs: number; size: number }
  try {
    const s = await stat(path)
    fileStat = { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size }
  } catch {
    return emptyState()
  }

  const cached = dreamingStateCache.get(path)
  if (
    cached !== undefined &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.ctimeMs === fileStat.ctimeMs &&
    cached.size === fileStat.size
  ) {
    return cached.state
  }

  const state = await loadDreamingStateFromDisk(path)
  dreamingStateCache.set(path, { ...fileStat, state })
  return state
}

async function loadDreamingStateFromDisk(path: string): Promise<DreamingState> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return emptyState()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyState()
  }

  if (!isDreamingState(parsed)) return emptyState()
  return parsed
}

export async function saveDreamingState(agentDir: string, state: DreamingState): Promise<void> {
  const path = join(agentDir, DREAMING_STATE_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function __resetDreamingStateCacheForTests(): void {
  dreamingStateCache.clear()
}

export function getDreamedIds(state: DreamingState, date: string): ReadonlySet<string> {
  const ids = state.dreamedThrough[date]?.dreamedIds
  return ids === undefined ? EMPTY_SET : new Set(ids)
}

export function addDreamedIds(state: DreamingState, date: string, ids: Iterable<string>, ts: string): DreamingState {
  const existing = state.dreamedThrough[date]?.dreamedIds ?? []
  const merged = new Set<string>(existing)
  for (const id of ids) merged.add(id)
  return {
    version: state.version,
    dreamedThrough: { ...state.dreamedThrough, [date]: { dreamedIds: [...merged].sort(), ts } },
  }
}

export function clearDreamedIds(state: DreamingState, date: string, ts: string): DreamingState {
  return {
    version: state.version,
    dreamedThrough: { ...state.dreamedThrough, [date]: { dreamedIds: [], ts } },
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set()

function isDreamingState(value: unknown): value is DreamingState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.version !== VERSION) return false
  if (typeof v.dreamedThrough !== 'object' || v.dreamedThrough === null) return false
  for (const [, entry] of Object.entries(v.dreamedThrough as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Record<string, unknown>
    if (!Array.isArray(e.dreamedIds)) return false
    if (!e.dreamedIds.every((id) => typeof id === 'string' && id.length > 0)) return false
    if (typeof e.ts !== 'string') return false
  }
  return true
}
