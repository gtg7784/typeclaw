// Blocks the "dumped review" anti-pattern: a REQUEST_CHANGES whose body anchors
// several `path:line` findings while the payload posts no inline `comments[]`.
// The github channel skill mandates `comments[]` and calls a flat-body review "a
// bug, not a fallback"; this enforces it. Scoped to REQUEST_CHANGES + REST
// `--input` payloads, since APPROVE/COMMENT bodies and the `gh pr review`
// porcelain carry no comparable `comments[]` to weigh the body against.

export type ReviewDumpInput = {
  command: string
  inputFileContents?: string | null
}

export type ReviewDumpDecision = { block: true; reason: string } | null

// A finding anchor as a reviewer writes it in prose: a file path (optionally with
// directories) ending in an extension, then `:line`, then an optional range/list
// (`107-111`, `807,809`, `12-20`). This is the real notation seen in dumped
// reviews — NOT GitHub blob `#L123` anchors, which point at files for reference
// rather than requesting a change on the diff.
const PATH_LINE_ANCHOR = /(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]*:\d+(?:[-,]\d+)*/g

const REVIEWS_ENDPOINT = /\/repos\/[^/\s]+\/[^/\s]+\/pulls\/\d+\/reviews\b/

// One or two anchors in a prose body is normal narration; at three+ a near-empty
// comments[] reads as a dump.
const MIN_ANCHORS = 3

export function detectReviewDump(input: ReviewDumpInput): ReviewDumpDecision {
  if (!REVIEWS_ENDPOINT.test(input.command)) return null
  const payload = parsePayload(input.inputFileContents ?? null)
  if (payload === null) return null
  if (payload.event !== 'REQUEST_CHANGES') return null

  const anchors = countAnchors(payload.body)
  if (anchors < MIN_ANCHORS) return null

  // Slack for a body that restates a couple of findings it also posts inline.
  if (payload.commentCount > Math.floor(anchors / 3)) return null

  return { block: true, reason: buildReason(anchors, payload.commentCount) }
}

type ReviewPayload = { event: string; body: string; commentCount: number }

function parsePayload(contents: string | null): ReviewPayload | null {
  if (contents === null || contents === '') return null
  try {
    const parsed = JSON.parse(contents) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    const event = typeof obj.event === 'string' ? obj.event.trim().toUpperCase() : ''
    const body = typeof obj.body === 'string' ? obj.body : ''
    const commentCount = Array.isArray(obj.comments) ? obj.comments.length : 0
    return { event, body, commentCount }
  } catch {
    return null
  }
}

function countAnchors(body: string): number {
  const matches = body.match(PATH_LINE_ANCHOR)
  if (matches === null) return 0
  // Distinct anchors only: repeating "foo.ts:10" three times is one finding.
  return new Set(matches).size
}

function buildReason(anchors: number, commentCount: number): string {
  return [
    `This REQUEST_CHANGES review body anchors ${anchors} findings to specific lines (path:line) but posts ${commentCount} inline comment${commentCount === 1 ? '' : 's'}.`,
    'Line-anchored change requests belong on the diff, not flattened into the review body.',
    'Re-submit with each finding as an entry in the `comments[]` array of the reviews payload',
    '(`{ "path": "...", "line": N, "side": "RIGHT", "body": "..." }`), keeping `body` for the high-level summary only.',
  ].join(' ')
}
