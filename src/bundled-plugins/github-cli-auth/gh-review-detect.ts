import type { ReviewVerdict } from '@/channels/github-review-turn-ledger'

// Extracts the formal-review verdict a successful `gh` command landed, so the
// false-receipt ledger can credit it. Covers the three vectors the agent uses to
// post a review: REST create-review via `--input <file>`, REST create-review via
// inline `-f/-F event=...`, and the `gh pr review` porcelain. Returns null when
// the command is not a verdict-bearing review submission (incl. COMMENT reviews,
// which carry no false-receipt risk and are not tracked).

// `source` drives success detection downstream: the REST endpoints echo the
// created review JSON, while the `gh pr review` porcelain prints a plain
// confirmation line — so each needs its own success markers (see review-recorder).
export type DetectedReview = {
  workspace: string
  prNumber: number
  verdict: ReviewVerdict
  source: 'api' | 'pr-review'
}

export type GhReviewDetectInput = {
  command: string
  // Contents of the file named by `--input <file>`, when the caller resolved it.
  // Kept as an injected value so this module does no I/O and stays sync+pure.
  inputFileContents?: string | null
}

const REVIEWS_ENDPOINT = /\/repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)\/reviews\b/

export function detectReviewSubmission(input: GhReviewDetectInput): DetectedReview | null {
  const args = splitArgs(input.command)
  if (args[0] !== 'gh') return null
  const sub = args[1]
  if (sub === 'api') return detectApiReview(args, input.inputFileContents ?? null)
  if (sub === 'pr' && args[2] === 'review') return detectPrReview(args)
  return null
}

function detectApiReview(args: readonly string[], fileContents: string | null): DetectedReview | null {
  const endpoint = args.find((a) => REVIEWS_ENDPOINT.test(a))
  if (endpoint === undefined) return null
  const m = REVIEWS_ENDPOINT.exec(endpoint)
  if (m === null) return null
  const workspace = `${m[1]}/${m[2]}`
  const prNumber = Number(m[3])
  if (!Number.isSafeInteger(prNumber)) return null

  const verdict = verdictFromInlineFields(args) ?? verdictFromFile(fileContents)
  if (verdict === null) return null
  return { workspace, prNumber, verdict, source: 'api' }
}

// Inline `-f event=APPROVE` / `--field event=REQUEST_CHANGES` (and `-F` raw).
// gh accepts both `flag value` and `flag=value` shapes; cover both.
function verdictFromInlineFields(args: readonly string[]): ReviewVerdict | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      const v = parseEventAssignment(args[i + 1])
      if (v !== null) return v
    }
    if (a.startsWith('-f=') || a.startsWith('-F=') || a.startsWith('--field=') || a.startsWith('--raw-field=')) {
      const v = parseEventAssignment(a.slice(a.indexOf('=') + 1))
      if (v !== null) return v
    }
  }
  return null
}

function parseEventAssignment(token: string | undefined): ReviewVerdict | null {
  if (token === undefined) return null
  const eq = token.indexOf('=')
  if (eq === -1) return null
  if (token.slice(0, eq).trim().toLowerCase() !== 'event') return null
  return normalizeVerdict(token.slice(eq + 1))
}

function verdictFromFile(contents: string | null): ReviewVerdict | null {
  if (contents === null || contents === '') return null
  try {
    const parsed = JSON.parse(contents) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const event = (parsed as Record<string, unknown>).event
    return typeof event === 'string' ? normalizeVerdict(event) : null
  } catch {
    return null
  }
}

function detectPrReview(args: readonly string[]): DetectedReview | null {
  const verdict =
    args.includes('--approve') || args.includes('-a')
      ? 'APPROVE'
      : args.includes('--request-changes') || args.includes('-r')
        ? 'REQUEST_CHANGES'
        : null
  if (verdict === null) return null
  const workspace = repoFromFlag(args)
  const prNumber = prNumberArg(args)
  if (workspace === null || prNumber === null) return null
  return { workspace, prNumber, verdict, source: 'pr-review' }
}

function repoFromFlag(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if ((a === '-R' || a === '--repo') && isRepoSlug(args[i + 1])) return args[i + 1] as string
    if (a.startsWith('--repo=') && isRepoSlug(a.slice('--repo='.length))) return a.slice('--repo='.length)
    if (a.startsWith('-R=') && isRepoSlug(a.slice('-R='.length))) return a.slice('-R='.length)
  }
  return null
}

function prNumberArg(args: readonly string[]): number | null {
  const start = args.indexOf('review') + 1
  for (let i = start; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a.startsWith('-')) continue
    if (/^\d+$/.test(a)) {
      const n = Number(a)
      return Number.isSafeInteger(n) ? n : null
    }
  }
  return null
}

function normalizeVerdict(value: string): ReviewVerdict | null {
  const v = value.trim().toUpperCase()
  if (v === 'APPROVE') return 'APPROVE'
  if (v === 'REQUEST_CHANGES') return 'REQUEST_CHANGES'
  return null
}

function isRepoSlug(value: string | undefined): boolean {
  if (value === undefined) return false
  const [owner, name, ...rest] = value.split('/')
  return owner !== undefined && owner !== '' && name !== undefined && name !== '' && rest.length === 0
}

// Quote-aware whitespace split. The interceptor guarantees a single bare `gh`
// command before we record (no pipes/substitution), so this only needs to honor
// quotes, not full shell grammar.
function splitArgs(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      has = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (has) {
        out.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += ch
    has = true
  }
  if (has) out.push(cur)
  return out
}
