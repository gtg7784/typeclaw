import type { PartialChannelOrigin } from './match-rule'

export type PendingClaim = {
  code: string
  role: string
  channel?: string
  ttlMs: number
  startedAt: number
  expiresAt: number
}

export type ClaimResult =
  | { kind: 'consumed'; code: string; role: string; matchRule: string; origin: PartialChannelOrigin }
  | { kind: 'no-pending' }
  | { kind: 'no-match' }
  | { kind: 'expired' }
  | { kind: 'wrong-channel' }

export type PendingClaimRegistry = {
  start: (claim: PendingClaim) => void
  cancel: (code: string) => boolean
  current: () => PendingClaim | null
  // Snapshot of consumption result without actually committing the grant.
  // The router calls this on every claim-code-bearing inbound; the grant
  // only fires when the result is 'consumed'.
  tryConsume: (
    code: string,
    origin: PartialChannelOrigin,
    formatMatchRule: (origin: PartialChannelOrigin) => string,
  ) => ClaimResult
  size: () => number
}

export type PendingClaimRegistryOptions = {
  now?: () => number
}

// Single-claim-at-a-time registry. A second `start` while one is pending
// replaces the prior code (cancels it implicitly): the operator running
// `typeclaw role claim` twice from two terminals expects the second invocation
// to take over, not error.
//
// Stored in-memory only — claim sessions are short-lived (default 10 min)
// and a container restart legitimately invalidates any pending window.
export function createPendingClaimRegistry(opts: PendingClaimRegistryOptions = {}): PendingClaimRegistry {
  const now = opts.now ?? Date.now
  let pending: PendingClaim | null = null

  type ExpiryCheck = { live: PendingClaim } | { live: null; reason: 'no-pending' | 'expired' }

  const expireIfDue = (): ExpiryCheck => {
    if (pending === null) return { live: null, reason: 'no-pending' }
    if (now() >= pending.expiresAt) {
      pending = null
      return { live: null, reason: 'expired' }
    }
    return { live: pending }
  }

  return {
    start(claim) {
      pending = { ...claim }
    },
    cancel(code) {
      if (pending !== null && pending.code === code) {
        pending = null
        return true
      }
      return false
    },
    current() {
      const check = expireIfDue()
      return check.live
    },
    tryConsume(code, origin, formatMatchRule) {
      const check = expireIfDue()
      if (check.live === null) {
        return { kind: check.reason }
      }
      const live = check.live
      if (code !== live.code) return { kind: 'no-match' }
      if (live.channel !== undefined && live.channel !== origin.adapter) {
        return { kind: 'wrong-channel' }
      }
      const matchRule = formatMatchRule(origin)
      const consumed: ClaimResult = {
        kind: 'consumed',
        code: live.code,
        role: live.role,
        matchRule,
        origin,
      }
      pending = null
      return consumed
    },
    size() {
      return expireIfDue().live === null ? 0 : 1
    },
  }
}
