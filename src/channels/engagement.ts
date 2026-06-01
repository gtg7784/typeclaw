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
  // Names the agent answers to in plain text (no @mention syntax). Built
  // by the router as `[basename(agentDir), ...config.alias]` and lowered
  // once. Empty list means alias-based engagement is off — useful for
  // tests and for agents that explicitly want strict-mention behavior.
  // Match semantics: case-insensitive substring of inbound text. This is
  // the operator contract documented in typeclaw-config; if a name is too
  // generic ("bot", "ai") it WILL produce false matches and the operator
  // owns curation.
  selfAliases: readonly string[]
  // True when the bot has previously sent into this exact thread (or
  // channel — the suppressor only checks this when the message is a
  // thread reply, but the field is general). Set by the router from
  // `live.successfulChannelSends > 0` plus any bot-authored prefetched
  // history in `contextBuffer`. Suppresses the `replyToOtherMessageId`
  // gate below: once the bot is participating in a thread, subsequent
  // replies are part of OUR conversation even when `parent_user_id` (the
  // thread root author) is a human. Without this, a thread that started
  // with a human @-mention drops every follow-up reply because Slack's
  // `parent_user_id` always points at the (human) thread root, never the
  // bot's intermediate replies — see incident in PR #58 follow-up.
  botInThread: boolean
}

export function decideEngagement(input: EngagementInput): EngagementDecision {
  const { message, config, key, ledger, now, participants, selfAliases, botInThread } = input

  // Peer bots are excluded from the count — a 1-human-N-bot room is still
  // "solo" for the fallback at the bottom.
  const effectiveHumans = countEffectiveHumans(participants, input.membership, now)

  if (config.trigger.includes('dm') && message.isDm) return 'engage'
  if (config.trigger.includes('mention') && message.isBotMention) return 'engage'
  if (config.trigger.includes('reply') && message.replyToBotMessageId !== null) return 'engage'

  // Sticky credit force-engages in EVERY context (groups included) for the
  // full window. This gate is deliberately content-blind: it answers "am I in
  // an active conversation with this author?", not "does THIS message need a
  // reply?" — a boolean over membership cannot tell "where did you send it?"
  // (reply) from "lol ok" (chatter). Selectivity is the MODEL's job: engaged
  // group turns get a `composeTurnPrompt` nudge (keyed off `isMultiHumanGroup`)
  // to answer real follow-ups and `NO_REPLY` chatter. Gating sticky off in
  // groups instead (the prior approach) dropped genuine follow-ups outright.
  if (config.stickiness !== 'off' && ledger.consume(key, message.authorId, now)) {
    return 'engage'
  }

  // Plain-text name addressing: the user wrote our name (or an alias)
  // somewhere in the message without using <@id> syntax. Engage at the
  // same priority as an explicit mention — operators add aliases
  // precisely because they expect the bot to respond when called by
  // name. Suppression on `mentionsOthers` would defeat the point: the
  // user can address two bots by name in one message ("봉봉아 펭펭아 둘
  // 다 봐") and both should engage. Each bot only knows its own
  // aliases, so cross-bot suppression isn't possible at this layer
  // anyway — the router-side peer-name suppression in the solo-human
  // fallback handles that case (follow-up).
  if (matchesAnyAlias(message.text, selfAliases)) return 'engage'

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
  // The replyToOtherMessageId suppressor exists to keep the bot out of
  // human-to-human side conversations in busy channels. But Slack's
  // `parent_user_id` is the THREAD ROOT author, not the immediate parent
  // author — so a thread the human starts by @-mentioning the bot
  // produces `replyToOtherMessageId` on every follow-up (root author is
  // the human, not us), which would silently drop every reply after the
  // first. Once the bot has actually sent into this thread, subsequent
  // replies are part of OUR conversation regardless of who started it,
  // so the suppressor stops applying. The two-humans-in-a-thread case
  // PR #58 fixed is preserved because the bot never sent into that
  // thread in the first place.
  if (message.replyToOtherMessageId !== null && !botInThread) return 'observe'

  // Plain-text peer-bot addressing as a fallback suppressor. We've reached
  // here because the message lacks a structural mention/reply/dm AND
  // doesn't contain our own alias. If it DOES contain a known peer bot's
  // observed display name, the solo-human fallback would still engage us
  // — same wrong behavior the alias trigger is meant to fix, just for
  // peers instead of self. Each bot only configures its own aliases, so
  // the only source of peer names is `participants[]` (observed
  // authorName once a peer has spoken at least once in this channel).
  // First-time addressing of a never-seen peer slips through; after that
  // peer's first message it's caught forever.
  if (textTargetsAnyPeerBot(message.text, participants)) return 'observe'

  if (effectiveHumans <= 1 && !message.authorIsBot) return 'engage'

  return 'observe'
}

export function countEffectiveHumans(
  participants: readonly ChannelParticipant[],
  membership: MembershipCount | null,
  now: number,
): number {
  const persistedHumans = participants.filter((p) => p.isBot !== true).length
  return resolveEffectiveHumans(persistedHumans, membership, now)
}

// A multi-human group is where the prompt's default "answer everything"
// eagerness needs tempering. The router reads this in `route()` to decide
// whether to append the group-chat nudge that tells the model to be selective
// (answer real follow-ups, `NO_REPLY` chatter) on its engaged turns. DMs and
// solo-human channels skip the nudge — there, replying to everything is right.
export function isMultiHumanGroup(isDm: boolean, effectiveHumans: number): boolean {
  return !isDm && effectiveHumans > 1
}

function textTargetsAnyPeerBot(text: string, participants: readonly ChannelParticipant[]): boolean {
  const haystack = text.toLocaleLowerCase()
  for (const p of participants) {
    if (p.isBot !== true) continue
    if (p.authorName === '') continue
    if (haystack.includes(p.authorName.toLocaleLowerCase())) return true
  }
  return false
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

export function matchesAnyAlias(text: string, lowercasedAliases: readonly string[]): boolean {
  if (lowercasedAliases.length === 0) return false
  const haystack = text.toLocaleLowerCase()
  for (const alias of lowercasedAliases) {
    if (haystack.includes(alias)) return true
  }
  return false
}
