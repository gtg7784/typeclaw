import type { ReviewVerdict } from '@/channels/github-review-turn-ledger'

// `NONE` covers "never reviewed" and "last decisive review was DISMISSED" — both
// mean a fresh verdict is legitimate (not a duplicate).
export type EffectiveVerdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'NONE'

export type EffectiveApprovalResolver = (target: {
  workspace: string
  prNumber: number
}) => Promise<{ ok: true; effective: EffectiveVerdict } | { ok: false }>

export type ApproveBlock = { block: true; reason: string }

export type ReviewVerdictGuard = {
  guard: (args: {
    callId: string
    workspace: string
    prNumber: number
    verdict: ReviewVerdict
  }) => Promise<ApproveBlock | null>
  release: (args: { callId: string; succeeded: boolean }) => void
}

// Back-compat alias: the guard now covers REQUEST_CHANGES too, not just APPROVE.
export type ApproveIdempotencyGuard = ReviewVerdictGuard

function duplicateReason(verdict: ReviewVerdict): string {
  if (verdict === 'APPROVE') {
    return (
      'This bot already holds a standing APPROVED review on this pull request. A second APPROVE would ' +
      'post a redundant review. If you intended to change your verdict, request changes or dismiss the ' +
      'prior review instead of re-approving.'
    )
  }
  return (
    'This bot already holds a standing CHANGES_REQUESTED review on this pull request. A second ' +
    'REQUEST_CHANGES would post a redundant blocking review. The prior review is still live — push a fix ' +
    'and APPROVE, or reply in the existing thread, instead of re-requesting changes.'
  )
}

const CONCURRENT_REASON =
  'Another session in this agent is already submitting a formal review verdict for this pull request. ' +
  'Only one verdict may land per PR — do not submit a second review; the in-flight one will post.'

// The standing verdict a fresh attempt would duplicate. APPROVE duplicates a
// standing APPROVED; REQUEST_CHANGES duplicates a standing CHANGES_REQUESTED.
function duplicatesStanding(verdict: ReviewVerdict, effective: EffectiveVerdict): boolean {
  return verdict === 'APPROVE' ? effective === 'APPROVED' : effective === 'CHANGES_REQUESTED'
}

// How long a reservation may sit before it is treated as abandoned. A normal
// `gh` review submit completes in seconds; this only guards against a tool.after
// that never fires (crash mid-command), so it must outlast a slow command yet
// never strand a PR for long.
const LEASE_TTL_MS = 5 * 60_000

type Reservation = { key: string; token: number; createdAt: number }

// MODULE-LEVEL singletons, shared by every plugin instance in this process. The
// github-cli-auth plugin's `plugin: async (ctx) => ...` factory may run once per
// session, giving each its own closure — but all of those closures import THIS
// module, so they coordinate through one Map. A closure-local Set (the prior
// design) could not see a concurrent session's in-flight verdict, which is how
// three sessions each landed an APPROVE on the same PR within ten seconds.
const inFlightByPr = new Map<string, Reservation>()
const reservationByCall = new Map<string, Reservation>()
let tokenSeq = 0

// Makes a formal `gh ... event=APPROVE|REQUEST_CHANGES` idempotent per PR across
// turns, sessions, and (in-process) concurrent fan-out. Two layers:
//
//   1. A process-wide in-flight lease keyed by `workspace#prNumber`, held from
//      tool.before through tool.after. While one verdict is mid-flight, every
//      other session's verdict for the same PR is blocked — even though GitHub
//      has not yet recorded the in-flight review. This is the layer the old
//      closure-local Set could not provide: separate plugin instances meant
//      separate Sets, so concurrent sessions never saw each other.
//
//   2. The authoritative GitHub effective-state read, consulted AFTER the lease
//      is acquired. It catches the cross-restart case (lease lost) and tracks
//      supersession: a later CHANGES_REQUESTED/DISMISSED demotes an earlier
//      APPROVED, so a genuine re-verdict is allowed. Reads fail OPEN — a
//      transient error must never strand a genuine first verdict; the lease
//      still covers the concurrent case while the command runs.
//
// The lease is released only in release() (tool.after) or on a terminal block,
// never after the remote read — releasing early reopens the TOCTOU the lease
// exists to close. Release is keyed by a per-call token so a late/stale
// tool.after for a superseded reservation cannot drop a newer session's lease.
export function createApproveIdempotencyGuard(deps: {
  resolveEffectiveApproval: EffectiveApprovalResolver
  now?: () => number
}): ReviewVerdictGuard {
  const now = deps.now ?? Date.now

  return {
    async guard(args): Promise<ApproveBlock | null> {
      if (args.verdict !== 'APPROVE' && args.verdict !== 'REQUEST_CHANGES') return null
      const key = prKey(args.workspace, args.prNumber)

      // Reserve BEFORE the await so two calls racing into guard() for the same PR
      // cannot both observe an empty map: the loser sees the winner's in-flight
      // lease and is blocked. An expired lease (tool.after never fired) is
      // reclaimable so a crash cannot permanently strand the PR.
      const held = inFlightByPr.get(key)
      if (held !== undefined && now() - held.createdAt < LEASE_TTL_MS) {
        return { block: true, reason: CONCURRENT_REASON }
      }
      const reservation: Reservation = { key, token: ++tokenSeq, createdAt: now() }
      inFlightByPr.set(key, reservation)
      reservationByCall.set(args.callId, reservation)

      const remote = await deps.resolveEffectiveApproval({ workspace: args.workspace, prNumber: args.prNumber })
      if (remote.ok && duplicatesStanding(args.verdict, remote.effective)) {
        // Standing verdict upstream already matches. Block, and release the lease
        // now: a blocked command never reaches tool.after, so release() won't run
        // for this callId. Leaving the lease set would resurrect the strand bug —
        // the GitHub read is authoritative for the standing case.
        releaseReservation(args.callId, reservation)
        return { block: true, reason: duplicateReason(args.verdict) }
      }

      return null
    },

    release(args): void {
      const reservation = reservationByCall.get(args.callId)
      if (reservation === undefined) return
      releaseReservation(args.callId, reservation)
    },
  }
}

// Drop the lease only if THIS reservation still owns the key. A stale tool.after
// for a reservation that was already superseded (e.g. reclaimed after TTL by a
// newer session) must not yank the live session's lease.
function releaseReservation(callId: string, reservation: Reservation): void {
  reservationByCall.delete(callId)
  const current = inFlightByPr.get(reservation.key)
  if (current !== undefined && current.token === reservation.token) {
    inFlightByPr.delete(reservation.key)
  }
}

function prKey(workspace: string, prNumber: number): string {
  return `${workspace}#${prNumber}`
}

// Test-only: clear the process-wide lease state between cases.
export function __resetReviewVerdictGuardForTest(): void {
  inFlightByPr.clear()
  reservationByCall.clear()
  tokenSeq = 0
}
