import { readFile } from 'node:fs/promises'

import { recordReview } from '@/channels/github-review-turn-ledger'
import type { ContentPart, ToolResult } from '@/plugin'

import { detectReviewSubmission, type DetectedReview } from './gh-review-detect'
import { detectReviewDump, type ReviewDumpDecision } from './gh-review-inline-detect'

// Bridges the bash `gh` interceptor to the false-receipt ledger: at tool.before
// we detect a review-submission command (resolving its --input file), stash it by
// callId, and at tool.after we credit the ledger ONLY if the command actually
// succeeded. Strict success detection is the safe bias here — wrongly crediting a
// review that never landed would re-open the false-receipt hole, so an ambiguous
// result is treated as "not landed" and left uncredited.

const pending = new Map<string, DetectedReview>()

const MAX_INPUT_BYTES = 1_000_000

export type NoteReviewResult = {
  dump: ReviewDumpDecision
  detected: DetectedReview | null
}

export async function noteReviewCommand(args: { callId: string; command: string }): Promise<NoteReviewResult> {
  const inputFileContents = await readInputFile(args.command)
  const detected = detectReviewSubmission({ command: args.command, inputFileContents })
  if (detected !== null) pending.set(args.callId, detected)
  return { dump: detectReviewDump({ command: args.command, inputFileContents }), detected }
}

export function commitReviewIfSucceeded(args: { sessionId: string; callId: string; result: ToolResult }): boolean {
  const detected = pending.get(args.callId)
  if (detected === undefined) return false
  pending.delete(args.callId)
  if (!looksSucceeded(detected, collectText(args.result.content))) return false
  recordReview({
    sessionId: args.sessionId,
    workspace: detected.workspace,
    prNumber: detected.prNumber,
    verdict: detected.verdict,
  })
  return true
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

// Success markers are vector-specific. The REST endpoints echo the created
// review JSON; the `gh pr review` porcelain prints a plain confirmation line
// ("✓ Approved pull request OWNER/REPO#N" / "+ Requested changes to pull
// request …", from cli/cli pkg/cmd/pr/review). Matching REST JSON markers
// against porcelain output left every `gh pr review --approve` uncredited, so a
// later "Approved" reply in the same turn was wrongly blocked.
const API_SUCCESS_MARKERS = [
  '"node_id":"PRR_',
  '"state":"APPROVED"',
  '"state":"CHANGES_REQUESTED"',
  '"state": "APPROVED"',
]
const PR_REVIEW_SUCCESS_MARKERS = ['Approved pull request', 'Requested changes to pull request']
const FAILURE_MARKERS = ['gh: ', 'HTTP 4', 'HTTP 5', 'Bad credentials', 'Not Found', 'Validation Failed']

// Require a success marker AND no failure marker, so a partial/garbled capture
// fails closed (uncredited).
function looksSucceeded(detected: DetectedReview, text: string): boolean {
  if (FAILURE_MARKERS.some((m) => text.includes(m))) return false
  const markers = detected.source === 'pr-review' ? PR_REVIEW_SUCCESS_MARKERS : API_SUCCESS_MARKERS
  return markers.some((m) => text.includes(m))
}

function collectText(content: readonly ContentPart[]): string {
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}
