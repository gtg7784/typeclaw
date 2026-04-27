import { existsSync, readFileSync } from 'node:fs'

const FRAGMENT_MARKER = /<!--\s*fragment\s+source=(\S+)\s+entry=(\S+)\s*-->/g

export function readWatermark(streamFilePath: string, parentSessionId: string): string | null {
  if (!existsSync(streamFilePath)) return null
  const content = readFileSync(streamFilePath, 'utf8')

  let lastEntryId: string | null = null
  for (const match of content.matchAll(FRAGMENT_MARKER)) {
    const [, source, entry] = match
    if (source === parentSessionId) lastEntryId = entry ?? null
  }
  return lastEntryId
}
