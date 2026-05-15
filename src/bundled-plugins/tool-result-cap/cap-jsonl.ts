import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

import type { ContentPart } from '@/plugin'

import { type CapOptions, type CapStats, capContentParts } from './cap-result'

export type CapJsonlStats = CapStats & {
  // Number of toolResult entries that had at least one part capped. Distinct
  // from imagesReplaced + textsTruncated because a single entry can have
  // multiple oversized parts.
  entriesMutated: number
}

export class CapJsonlReadError extends Error {
  constructor(
    public readonly path: string,
    public override readonly cause: unknown,
  ) {
    super(`capJsonlFileInPlace: read failed for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'CapJsonlReadError'
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}

function isToolResultMessageEntry(value: unknown): value is {
  type: 'message'
  message: { role: 'toolResult'; toolName?: string; content: ContentPart[] }
} {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as { type?: unknown; message?: unknown }
  if (entry.type !== 'message') return false
  if (typeof entry.message !== 'object' || entry.message === null) return false
  const message = entry.message as { role?: unknown; content?: unknown }
  if (message.role !== 'toolResult') return false
  if (!Array.isArray(message.content)) return false
  return true
}

// Apply `capContentParts` to every toolResult entry parsed from a JSONL file
// and rewrite the file in place when anything mutated. Idempotent.
//
// Why we own the file IO (rather than going through SessionManager): the
// `_rewriteFile` method on SessionManager is not on the public type, and
// running BEFORE `SessionManager.open(path)` is called means pi-coding-agent
// reads the already-capped file. No private API touched, no race against
// pi's internal state.
//
// Throws CapJsonlReadError when the file can't be read (missing, unreadable,
// directory, etc.). Callers that want best-effort no-op semantics should
// wrap in try/catch — see tryReopenOrCreate.
//
// Malformed lines are passed through verbatim — matches pi's parser, which
// silently skips them. We never delete or reorder entries; we only shrink
// `content` parts of toolResult messages.
//
// File mode is preserved across the temp+rename so a 0600 session JSONL
// stays 0600 after capping.
export function capJsonlFileInPlace(path: string, options: CapOptions): CapJsonlStats {
  let raw: string
  let originalMode: number
  try {
    raw = readFileSync(path, 'utf8')
    originalMode = statSync(path).mode & 0o777
  } catch (err) {
    throw new CapJsonlReadError(path, err)
  }

  const lines = raw.split('\n')
  const stats: CapJsonlStats = { imagesReplaced: 0, textsTruncated: 0, bytesElided: 0, entriesMutated: 0 }
  const out: string[] = Array.from({ length: lines.length })
  let anyMutated = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.length === 0) {
      out[i] = line
      continue
    }
    const parsed = parseLine(line)
    if (parsed === null || !isToolResultMessageEntry(parsed)) {
      out[i] = line
      continue
    }
    const toolName = parsed.message.toolName ?? ''
    const partStats = capContentParts(toolName, parsed.message.content, options)
    if (partStats.imagesReplaced > 0 || partStats.textsTruncated > 0) {
      stats.imagesReplaced += partStats.imagesReplaced
      stats.textsTruncated += partStats.textsTruncated
      stats.bytesElided += partStats.bytesElided
      stats.entriesMutated += 1
      anyMutated = true
      out[i] = JSON.stringify(parsed)
    } else {
      out[i] = line
    }
  }

  if (anyMutated) {
    // Write-then-rename so a crash mid-write can't leave a truncated JSONL
    // (which would corrupt the next rehydrate).
    const tmp = `${path}.cap.tmp`
    writeFileSync(tmp, out.join('\n'), { mode: originalMode })
    chmodSync(tmp, originalMode)
    renameSync(tmp, path)
  }

  return stats
}
