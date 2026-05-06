import { type MembershipResolverResult } from './membership'
import type { ChannelHistoryMessage, FetchHistoryResult } from './types'

// History-derived membership counts only the authors visible in the most
// recent N history messages — explicitly NOT a full guild/workspace
// membership snapshot. We mark `truncated: true` so the engagement layer
// (`resolveEffectiveHumans`) treats it as a quieting hint rather than
// ground truth and `Math.max`-folds it with persisted speakers.
//
// Used as a fallback when the platform's authoritative membership
// endpoint is unavailable (Discord 403 from missing GUILD_MEMBERS
// privileged intent, Slack `missing_scope` / `not_in_channel`, or any
// future adapter that lacks an enumeration capability), and as the
// preferred answer when the authoritative endpoint says "too many to
// enumerate" — a 1000-member guild's "5 active speakers" is more useful
// for engagement than "1000 members minus self".
//
// Returns a `transient` failure when history fetch itself fails, so the
// cache retries soon. Returns a count of zero humans/bots (rather than a
// failure) when history is empty — a brand-new channel is a legitimate
// state, not an error.
export const HISTORY_LOOKBACK_LIMIT = 100

export type DeriveMembershipDeps = {
  fetchHistory: (limit: number) => Promise<FetchHistoryResult>
  now: () => number
}

export async function deriveMembershipFromHistory(deps: DeriveMembershipDeps): Promise<MembershipResolverResult> {
  const result = await deps.fetchHistory(HISTORY_LOOKBACK_LIMIT)
  if (!result.ok) return { kind: 'transient' }
  return countAuthors(result.messages, deps.now())
}

export function countAuthors(messages: readonly ChannelHistoryMessage[], fetchedAt: number): MembershipResolverResult {
  // Dedupe by author id; once we've classified an author as bot or human
  // (via the adapter's `isBot` flag), keep that classification stable
  // even if a later message disagrees. The first occurrence wins for
  // determinism — Discord's `author.bot` and Slack's `subtype === 'bot_message'`
  // are stable for a given user, so disagreement would indicate a data
  // glitch we don't want to swing the count on.
  const seen = new Map<string, boolean>()
  for (const m of messages) {
    if (!seen.has(m.authorId)) seen.set(m.authorId, m.isBot)
  }
  let humans = 0
  let bots = 0
  for (const isBot of seen.values()) {
    if (isBot) bots++
    else humans++
  }
  return { humans, bots, fetchedAt, truncated: true }
}
