import type { ReviewVerdict } from '@/channels/github-review-turn-ledger'

// Raw latest-decisive state. DISMISSED is kept DISTINCT from NONE on purpose: a
// genuine dismissal means a fresh same-verdict re-review is legitimate and must
// NOT be shadowed by the read-after-write-lag cache (which only overrides a bare
// NONE — "GitHub shows no decisive review, but we just landed one"). Collapsing
// DISMISSED into NONE would let the lag cache re-strand a dismiss-then-reapprove,
// the exact failure 35287f99 removed.
export type EffectiveVerdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'NONE'

export type EffectiveApprovalResolver = (target: {
  workspace: string
  prNumber: number
}) => Promise<{ ok: true; effective: EffectiveVerdict } | { ok: false }>

// Resolves the PR's current head commit SHA. The landed-verdict cache keys on it
// so a genuine re-verdict on a NEW push is allowed while a same-commit duplicate
// is blocked. Resolved AFTER the in-flight lease is acquired, so the await does
// not widen the reserve-before-await race. Fails soft (null) — an unresolved SHA
// degrades the cache to verdict-only matching, never strands a genuine verdict.
export type HeadShaResolver = (target: { workspace: string; prNumber: number }) => Promise<string | null>

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

// How long a just-landed verdict is trusted to explain a GitHub `NONE` as
// read-after-write lag rather than a genuine absence. GitHub's `/pulls/<n>/reviews`
// list lags a write by up to ~10s, so a second engagement turn firing in that
// window reads NONE and would land a duplicate. Observed duplicates were ~10-18s
// apart; 60s is a comfortable lag margin without making a legitimate re-verdict
// wait long. This window only shadows a raw NONE on the SAME verdict + SAME head —
// a DISMISSED/CHANGES_REQUESTED/flipped-verdict/new-head all bypass it.
const RECENT_LANDED_TTL_MS = 60_000

type Reservation = { key: string; token: number; createdAt: number; headSha: string | null; verdict: ReviewVerdict }

// headSha is REQUIRED (never null): the cache is written only when the head was
// resolved, so a same-head equality check is always meaningful. An unresolved
// head skips the write entirely rather than storing a null that could never match.
type LandedVerdict = { verdict: ReviewVerdict; headSha: string; landedAt: number }

// MODULE-LEVEL singletons, shared by every plugin instance in this process. The
// github-cli-auth plugin's `plugin: async (ctx) => ...` factory may run once per
// session, giving each its own closure — but all of those closures import THIS
// module, so they coordinate through one Map. A closure-local Set (the prior
// design) could not see a concurrent session's in-flight verdict, which is how
// three sessions each landed an APPROVE on the same PR within ten seconds.
const inFlightByPr = new Map<string, Reservation>()
const reservationByCall = new Map<string, Reservation>()
const recentLandedByPr = new Map<string, LandedVerdict>()
let tokenSeq = 0

// Makes a formal `gh ... event=APPROVE|REQUEST_CHANGES` idempotent per PR across
// turns, sessions, and (in-process) concurrent fan-out. Three layers, in order:
//
//   1. A process-wide in-flight lease keyed by `workspace#prNumber`, held from
//      tool.before through tool.after. While one verdict is mid-flight, every
//      other session's verdict for the same PR is blocked — even though GitHub
//      has not yet recorded the in-flight review. This is the layer the old
//      closure-local Set could not provide: separate plugin instances meant
//      separate Sets, so concurrent sessions never saw each other.
//
//   2. The authoritative GitHub effective-state read, consulted AFTER the lease.
//      It is the SOLE source of truth for a standing verdict and for supersession:
//      a later CHANGES_REQUESTED/DISMISSED demotes an earlier APPROVED, so a
//      genuine re-verdict is allowed (the 35287f99 invariant — never block a
//      re-verdict on stale LOCAL memory). A standing same verdict blocks; DISMISSED
//      and the opposite decisive verdict pass. Reads fail OPEN.
//
//   3. A read-after-write-lag shield, consulted ONLY when layer 2 returns a raw
//      NONE. The lease (layer 1) covers two OVERLAPPING in-flight commands, but a
//      second engagement turn ~10s later starts after the first's lease released,
//      and GitHub's reviews list still lags the write (reports NONE). A short-lived
//      `recentLandedByPr` record — same verdict + same head, written on a succeeded
//      release, RECENT_LANDED_TTL_MS — disambiguates "NONE because lag" from "NONE
//      because genuinely absent": only the former blocks. Because it fires after a
//      raw NONE, a real DISMISSED/CHANGES_REQUESTED already allowed the re-verdict
//      at layer 2, so this cannot re-strand a supersession.
//
// The lease is released only in release() (tool.after) or on a terminal block,
// never after the remote read — releasing early reopens the TOCTOU the lease
// exists to close. Release is keyed by a per-call token so a late/stale
// tool.after for a superseded reservation cannot drop a newer session's lease.
export function createApproveIdempotencyGuard(deps: {
  resolveEffectiveApproval: EffectiveApprovalResolver
  resolveHeadSha?: HeadShaResolver
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
      const reservation: Reservation = {
        key,
        token: ++tokenSeq,
        createdAt: now(),
        headSha: null,
        verdict: args.verdict,
      }
      inFlightByPr.set(key, reservation)
      reservationByCall.set(args.callId, reservation)

      // Resolve the head SHA only AFTER the lease is held, so this await cannot
      // widen the reserve-before-await race the lease closes above.
      const headSha = (await deps.resolveHeadSha?.({ workspace: args.workspace, prNumber: args.prNumber })) ?? null
      reservation.headSha = headSha

      // Layer 2: GitHub is the authoritative, sole source of truth for a standing
      // verdict. A standing same verdict is a real duplicate; DISMISSED and the
      // opposite decisive verdict are genuine supersessions that must pass here
      // (the 35287f99 invariant). A read error fails OPEN.
      const remote = await deps.resolveEffectiveApproval({ workspace: args.workspace, prNumber: args.prNumber })
      if (remote.ok && duplicatesStanding(args.verdict, remote.effective)) {
        // Standing verdict upstream already matches. Block, and release the lease
        // now: a blocked command never reaches tool.after, so release() won't run
        // for this callId. Leaving the lease set would resurrect the strand bug —
        // the GitHub read is authoritative for the standing case.
        releaseReservation(args.callId, reservation)
        return { block: true, reason: duplicateReason(args.verdict) }
      }

      // Layer 3: only a raw NONE from a successful read is ambiguous — it can mean
      // "no review" or "our just-landed review not yet indexed". A recent same
      // verdict on the same head resolves it to lag and blocks the duplicate. Any
      // non-NONE state already decided above, so this never overrides a supersession.
      if (remote.ok && remote.effective === 'NONE' && recentlyLandedSame(key, args.verdict, headSha, now)) {
        releaseReservation(args.callId, reservation)
        return { block: true, reason: duplicateReason(args.verdict) }
      }

      return null
    },

    release(args): void {
      const reservation = reservationByCall.get(args.callId)
      if (reservation === undefined) return
      // Record only when the head was resolved: an unresolved head cannot key a
      // same-head lag check, so storing it would either never match or force a
      // verdict-only block that regresses the supersession invariant.
      if (args.succeeded && reservation.headSha !== null) {
        recentLandedByPr.set(reservation.key, {
          verdict: reservation.verdict,
          headSha: reservation.headSha,
          landedAt: now(),
        })
      }
      releaseReservation(args.callId, reservation)
    },
  }
}

// True only when a recently-landed record proves the GitHub NONE is read lag: same
// verdict, same head, within the lag window. A flipped verdict, a new head, or an
// expired/absent record all return false so the genuine re-verdict passes.
function recentlyLandedSame(key: string, verdict: ReviewVerdict, headSha: string | null, now: () => number): boolean {
  const landed = recentLandedByPr.get(key)
  if (landed === undefined) return false
  if (now() - landed.landedAt >= RECENT_LANDED_TTL_MS) return false
  return verdict === landed.verdict && headSha !== null && headSha === landed.headSha
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
  recentLandedByPr.clear()
  tokenSeq = 0
}
