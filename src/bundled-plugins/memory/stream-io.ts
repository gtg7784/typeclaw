import { readFile, appendFile, readdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { getDreamedIds, loadDreamingState } from './dreaming-state'
import { streamsDir } from './paths'
import { parseEventLine, type StreamEvent } from './stream-events'

const STREAM_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const STREAM_DATE_FROM_FILENAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

export async function readEvents(path: string): Promise<StreamEvent[]> {
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

export async function appendEvents(path: string, events: readonly StreamEvent[]): Promise<void> {
  if (events.length === 0) return
  const joined = events.map((e) => `${JSON.stringify(e)}\n`).join('')
  await appendFile(path, joined, 'utf-8')
}

export async function writeEventsAtomic(path: string, events: readonly StreamEvent[]): Promise<void> {
  const joined = events.map((e) => `${JSON.stringify(e)}\n`).join('')
  const tmp = `${path}.tmp`
  await writeFile(tmp, joined, 'utf-8')
  await rename(tmp, path)
}

// Locate the directory that holds daily-stream JSONL files for this agent.
// New layout is `memory/streams/`; pre-migration agents kept them flat under
// `memory/`. Returns `null` only when neither directory exists.
//
// `displayPrefix` is the user-visible path prefix consumers should render in
// prompt headings and search results so the agent sees stable identifiers
// regardless of which layout this particular folder is on.
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

// All undreamed events from every daily-stream file, oldest day first.
// One disk read per file plus one dreaming-state read total. Each entry
// carries the date, the on-disk path, the user-visible name, the post-filter
// event list, and a `partiallyDreamed` flag that callers can surface in
// rendered output (the injection path appends "(undreamed tail)" to the
// section heading). Days that come back fully dreamed are omitted.
//
// Returned in chronological order; callers that want newest-first should
// reverse. This matches the order the injection path already established
// so search results render in the same sequence.
export type UndreamedStreamDay = {
  date: string
  path: string
  name: string
  events: StreamEvent[]
  partiallyDreamed: boolean
}

export async function readAllUndreamedStreamDays(agentDir: string): Promise<UndreamedStreamDay[]> {
  const streamFiles = await listStreamFiles(agentDir)
  if (streamFiles === null) return []

  const { dir, displayPrefix, names } = streamFiles
  const dated = names.filter((n) => STREAM_FILE_PATTERN.test(n)).sort()
  const state = await loadDreamingState(agentDir)
  const days = await Promise.all(
    dated.map(async (name): Promise<UndreamedStreamDay | null> => {
      const date = STREAM_DATE_FROM_FILENAME.exec(name)?.[1] ?? ''
      const dreamedIds = getDreamedIds(state, date)
      const filePath = join(dir, name)
      const rawEvents = await readEvents(filePath)
      const undreamed = filterUndreamedEvents(rawEvents, dreamedIds)
      if (undreamed.length === 0) return null
      return {
        date,
        path: filePath,
        name: `${displayPrefix}/${name}`,
        events: undreamed,
        partiallyDreamed: undreamed.length < rawEvents.length,
      }
    }),
  )
  return days.filter((d): d is UndreamedStreamDay => d !== null)
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
