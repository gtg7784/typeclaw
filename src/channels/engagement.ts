import type { ChannelParticipant } from '@/agent/session-origin'

import { MEMBERSHIP_FRESHNESS_MS, type MembershipCount } from './membership'
import type { EngagementConfig } from './schema'
import type { InboundMessage } from './types'

export type EngagementDecision = 'engage' | 'observe'

export type StickyCredit = { authorId: string; expiresAt: number }

// Per-key sticky credit ledger. Each key (channel tuple) carries at most one
// active credit per author at a time (subsequent grants overwrite expiry).
export class StickyLedger {
  private byKey = new Map<string, Map<string, number>>()

  grant(key: string, authorId: string, expiresAt: number): void {
    let inner = this.byKey.get(key)
    if (!inner) {
      inner = new Map()
      this.byKey.set(key, inner)
    }
    inner.set(authorId, expiresAt)
  }

  consume(key: string, authorId: string, now: number): boolean {
    const inner = this.byKey.get(key)
    if (!inner) return false
    const expiresAt = inner.get(authorId)
    if (expiresAt === undefined) return false
    inner.delete(authorId)
    if (inner.size === 0) this.byKey.delete(key)
    return expiresAt > now
  }

  has(key: string, authorId: string, now: number): boolean {
    const expiresAt = this.byKey.get(key)?.get(authorId)
    return expiresAt !== undefined && expiresAt > now
  }

  clear(key: string): void {
    this.byKey.delete(key)
  }
}

export type EngagementInput = {
  message: InboundMessage
  config: EngagementConfig
  key: string
  ledger: StickyLedger
  now: number
  // Router updates this cache with the current sender BEFORE calling here,
  // so a fresh channel's first human message arrives with length 1. Peer
  // bots DO enter the cache now (they were dropped at adapter level
  // before), so the solo-human fallback below filters them out explicitly
  // — otherwise a 1-human + N-bot channel would silently exit solo mode.
  participants: readonly ChannelParticipant[]
  membership: MembershipCount | null
}

export function decideEngagement(input: EngagementInput): EngagementDecision {
  const { message, config, key, ledger, now, participants } = input

  if (config.trigger.includes('dm') && message.isDm) return 'engage'
  if (config.trigger.includes('mention') && message.isBotMention) return 'engage'
  if (config.trigger.includes('reply') && message.replyToBotMessageId !== null) return 'engage'

  if (config.stickiness !== 'off' && ledger.consume(key, message.authorId, now)) {
    return 'engage'
  }

  // Solo-human fallback: the strict mention/reply/dm gate keeps the bot
  // quiet in multi-human conversations, but in a 1-human channel that
  // same gate makes the agent silent on messages plainly meant for it.
  // The fallback engages on any human inbound when the channel has at
  // most one human participant, and reverts to strict the moment a second
  // human posts. Peer bots are tracked as participants for context but
  // excluded from the count here, so a 1-human channel stays "solo" even
  // when several bots also speak in it.
  //
  // Two suppressors override the fallback when the message is clearly
  // addressed to someone else:
  //   1. `mentionsOthers` — the message tags at least one other user and
  //      none of the mentions resolve to us.
  //   2. `replyToOtherMessageId` — the message is a reply, but the parent
  //      was authored by someone other than us (Discord's threaded reply
  //      arrow is the canonical case).
  // Both are populated by the adapter classifiers; either one flips the
  // fallback off for that single message without changing channel state.
  // Explicit triggers (DM, mention-of-us, reply-to-us, sticky) above are
  // unaffected — those still engage even when the message also tags a
  // third party.
  //
  // PEER BOTS NEVER QUALIFY for this fallback. It is a courtesy to humans
  // who don't want to type `@bot` in their own DM-like channel; peer bots
  // have no such ergonomic excuse. Letting peer bots ride the fallback
  // produced bot-to-bot conversations in 1-human-N-bot channels (observed:
  // Winky and 돌쇠 introducing themselves to each other after a single
  // "얘들아" from the human, then continuing to address each other for
  // ~6 turns). The router's loop guard only trips after 5 consecutive
  // peer engagements, which is too late to prevent the embarrassment.
  //
  // PHILOSOPHY (do not relitigate): peer bots remain reachable through
  // the SAME triggers as humans (mention/reply/dm/sticky); we do NOT
  // downgrade them to "mention-only". Bot-to-bot conversation is a
  // legitimate first-class use case in this codebase. The fix is to
  // close the unintended fallback, not to firewall bots behind explicit
  // mentions. A future maintainer (human or AI) tempted to add a
  // `peerBotTriggers: 'mention-only'` config — or any equivalent gate
  // that demands explicit `@bot` from peer bots — should not. The user
  // has rejected that design repeatedly. The right knob is `trigger`
  // (which already applies symmetrically to humans and bots) plus this
  // fallback fix.
  if (message.mentionsOthers) return 'observe'
  if (message.replyToOtherMessageId !== null) return 'observe'

  const persistedHumans = participants.filter((p) => p.isBot !== true).length
  const effectiveHumans = resolveEffectiveHumans(persistedHumans, input.membership, now)
  if (effectiveHumans <= 1 && !message.authorIsBot) return 'engage'

  return 'observe'
}

export function resolveEffectiveHumans(
  persistedHumans: number,
  membership: MembershipCount | null,
  now: number,
): number {
  if (membership === null) return persistedHumans
  // A fresh complete API read is the only signal that can see lurkers AND
  // prune recent leavers. Letting persisted speakers win here would preserve
  // the exact stale-authorship bug the membership lookup exists to fix.
  const isFresh = now - membership.fetchedAt < MEMBERSHIP_FRESHNESS_MS
  if (!membership.truncated && isFresh) return membership.humans
  // Truncated and stale reads are useful quieting hints, not ground truth.
  // Persisted speakers are bounded to the last 7 days, so `max()` avoids
  // under-counting active humans while the platform count is approximate.
  return Math.max(persistedHumans, membership.humans)
}

export function grantStickyForReplyTargets(
  ledger: StickyLedger,
  key: string,
  authorIds: readonly string[],
  config: EngagementConfig,
  now: number,
): void {
  if (config.stickiness === 'off') return
  const window = config.stickiness.perReply.window
  for (const id of authorIds) {
    ledger.grant(key, id, now + window)
  }
}
