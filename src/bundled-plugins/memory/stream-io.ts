import { readFile, appendFile, readdir, stat, writeFile, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { getDreamedIds, loadDreamingState } from './dreaming-state'
import { streamsDir } from './paths'
import { parseEventLine, type FragmentEvent, type StreamEvent } from './stream-events'

const STREAM_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const STREAM_DATE_FROM_FILENAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

export type FragmentsAppendedContext = {
  path: string
  date: string | null
}

// Per-file event cache. `(mtimeMs, ctimeMs, size)` is the invalidation key,
// mirroring `load-shards.ts`'s shard cache. The three writers in this module
// — `appendEvents` (memory-logger appends), `writeEventsAtomic` (dreaming
// compaction + migration), and any external `writeFile` — all bump mtime
// and/or ctime, so stat-based invalidation is sufficient without explicit
// hooks. ctimeMs guards metadata-preserving external edits (rsync -t,
// `touch -r`, restored backups, `git checkout` with timestamps): the kernel
// always bumps ctime on inode content changes and ctime cannot be backdated
// via utimes.
//
// Module-level keyed by absolute file path. One Bun process owns one agent
// dir in production (the container stage), so cardinality is small. Multi-
// path support exists because dreaming compacts multiple files per run and
// memory_search reads every dated stream.
type StreamFileCacheEntry = {
  mtimeMs: number
  ctimeMs: number
  size: number
  events: StreamEvent[]
}
const streamFileCache = new Map<string, StreamFileCacheEntry>()

export async function readEvents(path: string): Promise<StreamEvent[]> {
  const fileStat = await statFile(path)
  if (fileStat === null) {
    // File disappeared since last cache populate (e.g. dreaming dropped a
    // fully-GC'd day). Drop the entry so a future recreate gets fresh
    // content.
    streamFileCache.delete(path)
    return []
  }

  const cached = streamFileCache.get(path)
  if (
    cached !== undefined &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.ctimeMs === fileStat.ctimeMs &&
    cached.size === fileStat.size
  ) {
    return cached.events
  }

  const events = await readEventsFromDisk(path)
  streamFileCache.set(path, {
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    size: fileStat.size,
    events,
  })
  return events
}

async function readEventsFromDisk(path: string): Promise<StreamEvent[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }

  const lines = raw.split('\n')
  const events: StreamEvent[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line === '') continue
    const event = parseEventLine(line)
    if (event === null) {
      console.warn(`[stream-io] ${path}: skipping malformed line ${i + 1}`)
      continue
    }
    events.push(event)
  }

  return events
}

async function statFile(path: string): Promise<{ mtimeMs: number; ctimeMs: number; size: number } | null> {
  try {
    const s = await stat(path)
    return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// Test-only helper. Clears the in-memory stream-file cache so tests that
// exercise the cache invalidation path can simulate a cold start without
// spinning up a fresh process. Mirrors `__resetShardCacheForTests` in
// `load-shards.ts`.
export function __resetStreamFileCacheForTests(): void {
  streamFileCache.clear()
}

export async function appendEvents(
  path: string,
  events: readonly StreamEvent[],
  onFragmentsAppended?: (fragments: FragmentEvent[], context: FragmentsAppendedContext) => Promise<void>,
  onHookError?: (err: unknown) => void,
): Promise<void> {
  if (events.length === 0) return
  const joined = events.map((e) => `${JSON.stringify(e)}\n`).join('')
  await appendFile(path, joined, 'utf-8')
  if (onFragmentsAppended === undefined) return

  const fragments = events.filter((event): event is FragmentEvent => event.type === 'fragment')
  if (fragments.length === 0) return

  const context: FragmentsAppendedContext = { path, date: streamDateFromPath(path) }
  try {
    await onFragmentsAppended(fragments, context)
  } catch (err) {
    onHookError?.(err)
  }
}

function streamDateFromPath(path: string): string | null {
  return STREAM_DATE_FROM_FILENAME.exec(basename(path))?.[1] ?? null
}

export async function writeEventsAtomic(path: string, events: readonly StreamEvent[]): Promise<void> {
  const joined = events.map((e) => `${JSON.stringify(e)}\n`).join('')
  const tmp = `${path}.tmp`
  await writeFile(tmp, joined, 'utf-8')
  await rename(tmp, path)
}

// Daily-stream directory for this agent. New layout is `memory/streams/`;
// pre-migration agents kept them flat under `memory/`. `displayPrefix` is
// the path string consumers render so the agent sees a stable identifier
// regardless of which layout is on disk.
export type StreamDirectory = {
  dir: string
  displayPrefix: 'memory' | 'memory/streams'
  names: string[]
}

export async function listStreamFiles(agentDir: string): Promise<StreamDirectory | null> {
  const streamsDirPath = streamsDir(agentDir)
  try {
    const names = await readdir(streamsDirPath)
    return { dir: streamsDirPath, displayPrefix: 'memory/streams', names }
  } catch (err) {
    if (!isEnoent(err)) throw err
  }

  const legacyDir = join(agentDir, 'memory')
  try {
    const names = await readdir(legacyDir)
    return { dir: legacyDir, displayPrefix: 'memory', names }
  } catch (err) {
    if (!isEnoent(err)) throw err
    return null
  }
}

// Per-file slice with dreamed events removed. `events` is whatever
// `readEvents` returned for the file; `dreamedIds` is the day's slice from
// `getDreamedIds(state, date)`. Returns the events the next consumer should
// see — empty when every event has been dreamed.
//
// `legacy_prose` events pre-date the dreamed-id contract (they have no `id`)
// and are always kept. Same rule as the injection-side filter; lifted here
// so injection and search agree on what counts as undreamed.
export function filterUndreamedEvents(events: StreamEvent[], dreamedIds: ReadonlySet<string>): StreamEvent[] {
  if (dreamedIds.size === 0) return events
  return events.filter((event) => {
    if (event.type === 'legacy_prose') return true
    return !dreamedIds.has(event.id)
  })
}

// Raw events + per-day dreamed-id set, oldest day first. The dreamed filter
// is applied per-day by `readAllUndreamedStreamDays` — keeping it separate
// here lets callers that need unfiltered events read dreaming state once
// rather than re-loading it for every day.
export type StreamDay = {
  date: string
  path: string
  name: string
  events: StreamEvent[]
  dreamedIds: ReadonlySet<string>
}

export async function readAllStreamDays(agentDir: string): Promise<StreamDay[]> {
  const streamFiles = await listStreamFiles(agentDir)
  if (streamFiles === null) return []

  const { dir, displayPrefix, names } = streamFiles
  const dated = names.filter((n) => STREAM_FILE_PATTERN.test(n)).sort()
  const state = await loadDreamingState(agentDir)
  return Promise.all(
    dated.map(async (name): Promise<StreamDay> => {
      const date = STREAM_DATE_FROM_FILENAME.exec(name)?.[1] ?? ''
      const filePath = join(dir, name)
      return {
        date,
        path: filePath,
        name: `${displayPrefix}/${name}`,
        events: await readEvents(filePath),
        dreamedIds: getDreamedIds(state, date),
      }
    }),
  )
}

// Convenience wrapper for consumers that just want undreamed events without
// caring about filter ordering: pre-applies `filterUndreamedEvents` per day
// and drops fully-dreamed days. The injection path uses `readAllStreamDays`
// instead because it must order self-session and dreamed-id filters.
export type UndreamedStreamDay = {
  date: string
  path: string
  name: string
  events: StreamEvent[]
}

export async function readAllUndreamedStreamDays(agentDir: string): Promise<UndreamedStreamDay[]> {
  const days = await readAllStreamDays(agentDir)
  return days.flatMap((day) => {
    const undreamed = filterUndreamedEvents(day.events, day.dreamedIds)
    if (undreamed.length === 0) return []
    return [{ date: day.date, path: day.path, name: day.name, events: undreamed }]
  })
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT'
}

export async function countEvents(path: string): Promise<number> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw e
  }

  const lines = raw.split('\n')
  let count = 0

  for (const line of lines) {
    if (line === '') continue
    const event = parseEventLine(line)
    if (event !== null) count++
  }

  return count
}
