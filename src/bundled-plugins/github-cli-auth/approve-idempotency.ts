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
// and restarts. The per-turn review ledger only guards prose claims and resets
// every turn, so without this an APPROVE can fire again whenever the same PR
// fans out into a second session or a follow-up turn. We reserve the PR in an
// in-process set before the command runs (stops same-container concurrent
// double-approve) and consult GitHub for the bot's effective review state
// (stops cross-restart re-approval). Reads fail OPEN: a transient GitHub error
// must never permanently strand the bot from approving a PR it has not yet
// approved — the in-process reservation still blocks the concurrent case.
export function createApproveIdempotencyGuard(deps: {
  resolveEffectiveApproval: EffectiveApprovalResolver
}): ApproveIdempotencyGuard {
  const approvedOrPending = new Set<string>()
  const reservedByCall = new Map<string, string>()

  return {
    async guard(args): Promise<ApproveBlock | null> {
      if (args.verdict !== 'APPROVE') return null
      const key = prKey(args.workspace, args.prNumber)

      // Reserve BEFORE the await so two calls racing into guard() for the same
      // PR cannot both observe an empty set: the loser sees the winner's
      // reservation and is blocked. The reservation is provisional until the
      // remote check clears it.
      if (approvedOrPending.has(key)) return { block: true, reason: DUPLICATE_REASON }
      approvedOrPending.add(key)
      reservedByCall.set(args.callId, key)

      const remote = await deps.resolveEffectiveApproval({ workspace: args.workspace, prNumber: args.prNumber })
      if (remote.ok && remote.alreadyApproved) {
        // Already approved upstream: keep the PR locked but drop this call's
        // claim so release() won't later unlock a PR that is genuinely approved.
        reservedByCall.delete(args.callId)
        return { block: true, reason: DUPLICATE_REASON }
      }

      return null
    },

    release(args): void {
      const key = reservedByCall.get(args.callId)
      if (key === undefined) return
      reservedByCall.delete(args.callId)
      if (!args.succeeded) approvedOrPending.delete(key)
    },
  }
}

function prKey(workspace: string, prNumber: number): string {
  return `${workspace}#${prNumber}`
}
