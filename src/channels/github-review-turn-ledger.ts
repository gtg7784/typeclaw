// In-process record of REAL github review actions performed during the current
// turn, shared across two plugin boundaries: github-cli-auth records a formal
// review / thread-resolve here after the `gh` command SUCCEEDS, and channel-reply
// consults it before sending a verdict/close-out reply. If the agent claims a
// verdict in prose but this ledger shows no matching action this turn, the reply
// is a false receipt (see channel-reply.ts). State is per-session and reset at
// turn start, so a claim must be backed by an action in the SAME turn.

export type ReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES'

export type ReviewObserver = (args: {
  sessionId: string
  workspace: string
  prNumber: number
  verdict: ReviewVerdict
}) => void

type PrKey = string
type ThreadKey = string

const reviewsByPr = new Map<PrKey, Set<ReviewVerdict>>()
const resolvedThreads = new Set<ThreadKey>()

// A single process-wide observer notified AFTER a verdict is recorded, so the
// run-side wiring can fan a landed verdict out over the broadcast bus to sibling
// PR sessions (see github-verdict-activity.ts) WITHOUT giving the github-cli-auth
// plugin stream access. Registered once at boot from run/index.ts. The ledger
// stays the single seam where "a formal verdict happened" is known across the
// plugin/channels boundary, which is why it owns this hook.
let reviewObserver: ReviewObserver | null = null

export function setReviewObserver(observer: ReviewObserver | null): void {
  reviewObserver = observer
}

export function __resetReviewObserverForTest(): void {
  reviewObserver = null
}

function prKey(sessionId: string, workspace: string, prNumber: number): PrKey {
  return `${sessionId}::${workspace}::${prNumber}`
}

function threadKey(sessionId: string, workspace: string, prNumber: number, rootCommentId: string): ThreadKey {
  return `${sessionId}::${workspace}::${prNumber}::${rootCommentId}`
}

export function resetReviewTurn(sessionId: string): void {
  for (const key of reviewsByPr.keys()) {
    if (key.startsWith(`${sessionId}::`)) reviewsByPr.delete(key)
  }
  for (const key of resolvedThreads) {
    if (key.startsWith(`${sessionId}::`)) resolvedThreads.delete(key)
  }
}

export function recordReview(args: {
  sessionId: string
  workspace: string
  prNumber: number
  verdict: ReviewVerdict
}): void {
  const key = prKey(args.sessionId, args.workspace, args.prNumber)
  const set = reviewsByPr.get(key) ?? new Set<ReviewVerdict>()
  set.add(args.verdict)
  reviewsByPr.set(key, set)
  // Notify AFTER the record lands and never let an observer failure corrupt the
  // ledger write — the false-receipt guard depends on this record being durable.
  if (reviewObserver !== null) {
    try {
      reviewObserver(args)
    } catch {
      // swallow: a broken broadcast must not break verdict bookkeeping
    }
  }
}

export function hasReview(args: {
  sessionId: string
  workspace: string
  prNumber: number
  verdict: ReviewVerdict
}): boolean {
  return reviewsByPr.get(prKey(args.sessionId, args.workspace, args.prNumber))?.has(args.verdict) ?? false
}

export function recordResolvedThread(args: {
  sessionId: string
  workspace: string
  prNumber: number
  rootCommentId: string
}): void {
  resolvedThreads.add(threadKey(args.sessionId, args.workspace, args.prNumber, args.rootCommentId))
}

export function hasResolvedThread(args: {
  sessionId: string
  workspace: string
  prNumber: number
  rootCommentId: string
}): boolean {
  return resolvedThreads.has(threadKey(args.sessionId, args.workspace, args.prNumber, args.rootCommentId))
}
