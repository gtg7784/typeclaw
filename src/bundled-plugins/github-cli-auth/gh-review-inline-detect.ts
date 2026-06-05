// Blocks the "dumped review" anti-pattern: a REQUEST_CHANGES whose body anchors
// `path:line` findings that are not actually posted as inline `comments[]`. The
// github channel skill mandates `comments[]` and calls a flat-body review "a bug,
// not a fallback"; this enforces it. Scoped to REQUEST_CHANGES + REST `--input`
// payloads, since APPROVE/COMMENT bodies and the `gh pr review` porcelain carry
// no comparable `comments[]` to weigh the body against.
//
// A body anchor is "covered" only when an inline comment sits at the same path
// and a line inside the anchor's range — so a partially-inline review that posts
// a few token comments while leaving other findings stranded in the body is still
// blocked on the stranded ones.

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
const PATH_LINE_ANCHOR = /((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]\w*):(\d+(?:[-,]\d+)*)/g

const REVIEWS_ENDPOINT = /\/repos\/[^/\s]+\/[^/\s]+\/pulls\/\d+\/reviews\b/

// One or two anchors in a prose body is normal narration; at three+ uncovered
// anchors a review reads as a dump.
const MIN_ANCHORS = 3

export function detectReviewDump(input: ReviewDumpInput): ReviewDumpDecision {
  if (!REVIEWS_ENDPOINT.test(input.command)) return null
  const payload = parsePayload(input.inputFileContents ?? null)
  if (payload === null) return null
  if (payload.event !== 'REQUEST_CHANGES') return null

  const anchors = parseAnchors(payload.body)
  if (anchors.length < MIN_ANCHORS) return null

  const uncovered = anchors.filter((anchor) => !isCoveredInline(anchor, payload.comments))
  if (uncovered.length === 0) return null

  return { block: true, reason: buildReason(anchors.length, uncovered.length, payload.comments.length) }
}

type Anchor = { path: string; lines: ReadonlySet<number> }
type InlineComment = { path: string; line: number }
type ReviewPayload = { event: string; body: string; comments: readonly InlineComment[] }

function parsePayload(contents: string | null): ReviewPayload | null {
  if (contents === null || contents === '') return null
  try {
    const parsed = JSON.parse(contents) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    const event = typeof obj.event === 'string' ? obj.event.trim().toUpperCase() : ''
    const body = typeof obj.body === 'string' ? obj.body : ''
    const comments = parseComments(obj.comments)
    return { event, body, comments }
  } catch {
    return null
  }
}

function parseComments(value: unknown): InlineComment[] {
  if (!Array.isArray(value)) return []
  const out: InlineComment[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    const path = typeof rec.path === 'string' ? rec.path : null
    // GitHub keys an inline comment on `line` (and `start_line` for a span); a
    // span covers each line it touches.
    const line = typeof rec.line === 'number' ? rec.line : null
    if (path === null || line === null) continue
    const startLine = typeof rec.start_line === 'number' ? rec.start_line : line
    for (let l = Math.min(startLine, line); l <= Math.max(startLine, line); l++) {
      out.push({ path, line: l })
    }
  }
  return out
}

function parseAnchors(body: string): Anchor[] {
  const seen = new Set<string>()
  const out: Anchor[] = []
  for (const m of body.matchAll(PATH_LINE_ANCHOR)) {
    const key = `${m[1]}:${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path: m[1] as string, lines: expandLineSpec(m[2] as string) })
  }
  return out
}

// `12-20` -> 12..20; `807,809` -> {807,809}; `42` -> {42}.
function expandLineSpec(spec: string): Set<number> {
  const lines = new Set<number>()
  for (const part of spec.split(',')) {
    const range = part.split('-')
    const start = Number(range[0])
    const end = range.length > 1 ? Number(range[1]) : start
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue
    for (let l = Math.min(start, end); l <= Math.max(start, end); l++) lines.add(l)
  }
  return lines
}

// The body writes short paths (`languages.ts`) while comments[] carry full repo
// paths (`apps/.../languages.ts`); treat a comment as on-path when either path
// ends with the other (segment-aligned), so the basename match is exact.
function isCoveredInline(anchor: Anchor, comments: readonly InlineComment[]): boolean {
  return comments.some((c) => pathsAlign(anchor.path, c.path) && anchor.lines.has(c.line))
}

function pathsAlign(anchorPath: string, commentPath: string): boolean {
  if (anchorPath === commentPath) return true
  return commentPath.endsWith(`/${anchorPath}`) || anchorPath.endsWith(`/${commentPath}`)
}

function buildReason(total: number, uncovered: number, commentCount: number): string {
  return [
    `This REQUEST_CHANGES review body anchors ${total} findings to specific lines (path:line), but ${uncovered} of them ${uncovered === 1 ? 'is' : 'are'} not posted as inline comments (payload has ${commentCount} inline comment${commentCount === 1 ? '' : 's'}).`,
    'Every line-anchored change request belongs on its diff line, not flattened into the review body.',
    'Re-submit with each stranded finding as an entry in the `comments[]` array of the reviews payload',
    '(`{ "path": "...", "line": N, "side": "RIGHT", "body": "..." }`), keeping `body` for the high-level summary only.',
  ].join(' ')
}
