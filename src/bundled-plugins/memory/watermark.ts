import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const WATERMARK_MARKER = /<!--\s*(?:fragment|watermark)\s+source=(\S+)\s+entry=(\S+)(?:\s+\S+=\S+)*\s*-->/g

// Daily stream files are named `YYYY-MM-DD.md` (see `formatLocalDate` in
// `src/shared`). The cross-day lookup ignores any other `.md` file the user
// or a plugin may have dropped into `memory/`.
const DAILY_STREAM_NAME = /^\d{4}-\d{2}-\d{2}\.md$/

export function readWatermarkFromFile(streamFilePath: string, parentSessionId: string): string | null {
  if (!existsSync(streamFilePath)) return null
  const content = readFileSync(streamFilePath, 'utf8')

  let lastEntryId: string | null = null
  for (const match of content.matchAll(WATERMARK_MARKER)) {
    const [, source, entry] = match
    if (source === parentSessionId) lastEntryId = entry ?? null
  }
  return lastEntryId
}

// Returns the latest watermark entry id for `parentSessionId` across all
// `YYYY-MM-DD.md` daily-stream files under `memoryDir`, walking newest-first
// (by filename, which is equivalent to chronological order). Short-circuits
// on the first file that contains a matching marker — for the common case
// where memory-logger ran yesterday, this reads exactly one file.
//
// Why cross-day: channel sessions (Slack, Discord, KakaoTalk) routinely
// survive the midnight rollover because the same human keeps the same
// session alive across days. If `readWatermark` only looked at today's
// stream file, every midnight would force a full transcript reread for
// every long-lived session — burning ~135k input tokens per memory-logger
// run on a 762KB transcript (observed on a real Discord agent: PR #207).
//
// The append target stays today's file; only the lookup crosses the day
// boundary. This means yesterday's stream is treated as read-only history,
// which it already is by construction (dreaming snapshots full days, never
// touches in-progress days).
export function readLatestWatermark(memoryDir: string, parentSessionId: string): string | null {
  if (!existsSync(memoryDir)) return null
  let entries: string[]
  try {
    entries = readdirSync(memoryDir)
  } catch {
    return null
  }
  const dailyStreams = entries
    .filter((name) => DAILY_STREAM_NAME.test(name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const name of dailyStreams) {
    const watermark = readWatermarkFromFile(join(memoryDir, name), parentSessionId)
    if (watermark !== null) return watermark
  }
  return null
}
