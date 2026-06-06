import type { ReviewVerdict } from '@/channels/github-review-turn-ledger'

export type EffectiveApprovalResolver = (target: {
  workspace: string
  prNumber: number
}) => Promise<{ ok: true; alreadyApproved: boolean } | { ok: false }>

export type ApproveBlock = { block: true; reason: string }

export type ApproveIdempotencyGuard = {
  guard: (args: {
    callId: string
    workspace: string
    prNumber: number
    verdict: ReviewVerdict
  }) => Promise<ApproveBlock | null>
  release: (args: { callId: string; succeeded: boolean }) => void
}

const DUPLICATE_REASON =
  'This bot has already approved this pull request. A second APPROVE would post a redundant review. ' +
  'If you intended to change your verdict, request changes or dismiss the prior review instead of re-approving.'

// Makes formal `gh ... event=APPROVE` idempotent per PR across turns, sessions,
// and restarts. Two layers, each with a single job:
//
//   1. An in-process set of *in-flight* reservations (`pendingApprovals`) that
//      blocks a second APPROVE while a first is still mid-flight in the same
//      container — the concurrent-double-approve case the remote read can't see
//      yet (GitHub hasn't recorded the in-flight review).
//   2. The authoritative GitHub effective-state read, the SOLE source of truth
//      for "the bot already holds a standing APPROVED review." It understands
//      supersession: a later CHANGES_REQUESTED / DISMISSED demotes an earlier
//      APPROVED, so the bot may legitimately re-approve.
//
// The set is strictly an in-flight lock — never a persistent "already approved"
// memory. A completed APPROVE drops its reservation in release(), so the next
// APPROVE re-consults GitHub instead of being shadowed by a stale local entry.
// That separation fixes the strand bug: once a standing approval is superseded
// (PR back to CHANGES_REQUESTED), a stale local lock must not keep blocking a
// genuine re-approve — only the remote read decides, and it now reports
// alreadyApproved=false. Reads fail OPEN: a transient GitHub error must never
// permanently strand a first approval; the in-flight reservation still covers
// the concurrent case.
export function createApproveIdempotencyGuard(deps: {
  resolveEffectiveApproval: EffectiveApprovalResolver
}): ApproveIdempotencyGuard {
  const pendingApprovals = new Set<string>()
  const reservedByCall = new Map<string, string>()

  return {
    async guard(args): Promise<ApproveBlock | null> {
      if (args.verdict !== 'APPROVE') return null
      const key = prKey(args.workspace, args.prNumber)

      // Reserve BEFORE the await so two calls racing into guard() for the same
      // PR cannot both observe an empty set: the loser sees the winner's
      // in-flight reservation and is blocked. The reservation is provisional
      // and is always cleared on a terminal path (block below or release()).
      if (pendingApprovals.has(key)) return { block: true, reason: DUPLICATE_REASON }
      pendingApprovals.add(key)
      reservedByCall.set(args.callId, key)

      const remote = await deps.resolveEffectiveApproval({ workspace: args.workspace, prNumber: args.prNumber })
      if (remote.ok && remote.alreadyApproved) {
        // Standing approval upstream. Block, and release the in-flight lock now:
        // a blocked command never reaches tool.after, so release() won't run for
        // this callId. Leaving the key set would resurrect the strand bug — the
        // GitHub read is authoritative for the standing-approval case, not a
        // lingering local entry.
        reservedByCall.delete(args.callId)
        pendingApprovals.delete(key)
        return { block: true, reason: DUPLICATE_REASON }
      }

      return null
    },

    release(args): void {
      const key = reservedByCall.get(args.callId)
      if (key === undefined) return
      reservedByCall.delete(args.callId)
      // Always drop the in-flight lock, success or fail. On success the standing
      // approval now lives on GitHub, so future APPROVEs are caught by the remote
      // read (which tracks supersession); the local lock must not outlive the
      // in-flight window and shadow that read.
      pendingApprovals.delete(key)
    },
  }
}

function prKey(workspace: string, prNumber: number): string {
  return `${workspace}#${prNumber}`
}
