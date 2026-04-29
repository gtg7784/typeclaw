import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DREAMING_STATE_FILE = 'memory/.dreaming-state.json'

const VERSION = 1

// Per-day watermark: the number of lines of `memory/yyyy-MM-dd.md` that have
// been consolidated into MEMORY.md. The next dreaming run reads only the tail
// past this point. The next system-prompt injection (loadMemory) shows only
// the tail too, so already-consolidated content does not appear twice.
//
// We deliberately track lines (not bytes) because line-based slicing is
// human-inspectable and the `fragments:` citations in MEMORY.md already use
// `memory/yyyy-MM-dd:<line>-<line>` notation.
export type DreamingState = {
  version: number
  dreamedThrough: Record<string, DreamedDay>
}

export type DreamedDay = {
  lines: number
  ts: string
}

export function emptyState(): DreamingState {
  return { version: VERSION, dreamedThrough: {} }
}

// Missing or unreadable file → empty state. Malformed JSON or wrong shape is
// also treated as empty: the cost is one redundant re-consolidation, which is
// strictly safer than crashing the dreaming pipeline because of a bad state
// file.
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

export function getDreamedLines(state: DreamingState, date: string): number {
  return state.dreamedThrough[date]?.lines ?? 0
}

export function setDreamedLines(state: DreamingState, date: string, lines: number, ts: string): DreamingState {
  return {
    version: state.version,
    dreamedThrough: { ...state.dreamedThrough, [date]: { lines, ts } },
  }
}

function isDreamingState(value: unknown): value is DreamingState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.version !== VERSION) return false
  if (typeof v.dreamedThrough !== 'object' || v.dreamedThrough === null) return false
  for (const [, entry] of Object.entries(v.dreamedThrough as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Record<string, unknown>
    if (typeof e.lines !== 'number' || e.lines < 0) return false
    if (typeof e.ts !== 'string') return false
  }
  return true
}
