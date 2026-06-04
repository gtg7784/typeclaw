import { readFile } from 'node:fs/promises'

import { recordReview } from '@/channels/github-review-turn-ledger'
import type { ContentPart, ToolResult } from '@/plugin'

import { detectReviewSubmission, type DetectedReview } from './gh-review-detect'

// Bridges the bash `gh` interceptor to the false-receipt ledger: at tool.before
// we detect a review-submission command (resolving its --input file), stash it by
// callId, and at tool.after we credit the ledger ONLY if the command actually
// succeeded. Strict success detection is the safe bias here — wrongly crediting a
// review that never landed would re-open the false-receipt hole, so an ambiguous
// result is treated as "not landed" and left uncredited.

const pending = new Map<string, DetectedReview>()

const MAX_INPUT_BYTES = 1_000_000

export async function noteReviewCommand(args: { callId: string; command: string }): Promise<void> {
  const inputFileContents = await readInputFile(args.command)
  const detected = detectReviewSubmission({ command: args.command, inputFileContents })
  if (detected !== null) pending.set(args.callId, detected)
}

export function commitReviewIfSucceeded(args: { sessionId: string; callId: string; result: ToolResult }): void {
  const detected = pending.get(args.callId)
  if (detected === undefined) return
  pending.delete(args.callId)
  if (!looksSucceeded(collectText(args.result.content))) return
  recordReview({
    sessionId: args.sessionId,
    workspace: detected.workspace,
    prNumber: detected.prNumber,
    verdict: detected.verdict,
  })
}

async function readInputFile(command: string): Promise<string | null> {
  const path = inputFilePath(command)
  if (path === null) return null
  try {
    const buf = await readFile(path)
    if (buf.byteLength > MAX_INPUT_BYTES) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

function inputFilePath(command: string): string | null {
  const m = /(?:^|\s)--input(?:=|\s+)(\S+)/.exec(command)
  if (m === null) return null
  const raw = m[1] as string
  if (raw === '-') return null
  return stripQuotes(raw)
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1)
  }
  return value
}

// A landed review POST echoes the created review JSON (its node id / state); a
// rejected one prints a gh/HTTP error. Require a success marker AND no failure
// marker, so a partial/garbled capture fails closed (uncredited).
const SUCCESS_MARKERS = ['"node_id":"PRR_', '"state":"APPROVED"', '"state":"CHANGES_REQUESTED"', '"state": "APPROVED"']
const FAILURE_MARKERS = ['gh: ', 'HTTP 4', 'HTTP 5', 'Bad credentials', 'Not Found', 'Validation Failed']

function looksSucceeded(text: string): boolean {
  if (FAILURE_MARKERS.some((m) => text.includes(m))) return false
  return SUCCESS_MARKERS.some((m) => text.includes(m))
}

function collectText(content: readonly ContentPart[]): string {
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}
