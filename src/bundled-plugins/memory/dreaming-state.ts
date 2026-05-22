import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DREAMING_STATE_FILE = 'memory/.dreaming-state.json'

const VERSION = 2

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
  if (!existsSync(path)) return emptyState()

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
