import type { ChannelKey } from './types'

export const MEMBERSHIP_ENUMERATION_CAP = 50
export const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000
export const MEMBERSHIP_CACHE_PERMANENT_TTL_MS = 5 * 60 * 1000
export const MEMBERSHIP_CACHE_TRANSIENT_TTL_MS = 30_000
export const MEMBERSHIP_FRESHNESS_MS = 60_000
export const MEMBERSHIP_COLD_FETCH_TIMEOUT_MS = 1500

export type MembershipCount = {
  humans: number
  bots: number
  fetchedAt: number
  truncated: boolean
}

export type MembershipResolverFailure = { kind: 'transient' } | { kind: 'permanent' }

export type MembershipResolverResult = MembershipCount | MembershipResolverFailure

export type MembershipResolver = (key: ChannelKey) => Promise<MembershipResolverResult>
