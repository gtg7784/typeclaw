import { readFile, appendFile, writeFile, rename } from 'node:fs/promises'

import { parseEventLine, type StreamEvent } from './stream-events'

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
