import type { ChannelKey } from './types'

export const MEMBERSHIP_ENUMERATION_CAP = 50
// Engagement decisions read this every inbound but tolerate moderate
// staleness — the count rarely changes between turns. The router
// invalidates the cache when a previously-unseen author posts (see
// router.ts), so the only practical sources of staleness this TTL
// governs are: (1) silent leavers we don't notice until next refetch,
// (2) lurkers with permission overwrites who never speak. Both are
// quieting hints at most. 30min matches the upper bound of "session
// idle" so the cache typically expires around the same time the
// LiveSession would be GC'd anyway.
export const MEMBERSHIP_CACHE_TTL_MS = 30 * 60 * 1000
export const MEMBERSHIP_CACHE_PERMANENT_TTL_MS = 5 * 60 * 1000
export const MEMBERSHIP_CACHE_TRANSIENT_TTL_MS = 30_000
export const MEMBERSHIP_FRESHNESS_MS = 60_000
export const MEMBERSHIP_COLD_FETCH_TIMEOUT_MS = 1500

export type MembershipCount = {
  humans: number
  bots: number
  fetchedAt: number
  truncated: boolean
  // Identities of the human members, present ONLY when the adapter enumerated
  // the COMPLETE current membership and classified every listed member in the
  // same pass that produced `humans`. When set, `humanMemberIds.length` equals
  // `humans` by construction, so a consumer can prove "every human in the room
  // is X" by resolving each id — something the bare `humans` count cannot do.
  // Left undefined by approximate/truncated/history-derived reads and by
  // adapters that cannot enumerate members (Telegram, KakaoTalk); consumers
  // that need a completeness proof must fail closed when it is absent.
  humanMemberIds?: readonly string[]
}

export type MembershipResolverFailure = { kind: 'transient' } | { kind: 'permanent' }

export type MembershipResolverResult = MembershipCount | MembershipResolverFailure

export type MembershipResolver = (key: ChannelKey) => Promise<MembershipResolverResult>
