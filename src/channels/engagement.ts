import type { ChannelParticipant } from '@/agent/session-origin'

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
  // so a fresh channel's first human message arrives with length 1. Bots
  // never enter the cache (filtered at adapter), so 1 human + N bots is
  // length 1.
  participants: readonly ChannelParticipant[]
}

export function decideEngagement(input: EngagementInput): EngagementDecision {
  const { message, config, key, ledger, now, participants } = input

  if (config.trigger.includes('dm') && message.isDm) return 'engage'
  if (config.trigger.includes('mention') && message.isBotMention) return 'engage'
  if (config.trigger.includes('reply') && message.replyToBotMessageId !== null) return 'engage'

  if (config.stickiness !== 'off' && ledger.consume(key, message.authorId, now)) {
    return 'engage'
  }

  // Solo-human fallback: the strict mention/reply/dm gate exists to keep
  // the bot quiet in multi-human conversations. In a 1-human channel that
  // protection makes the agent silent on messages obviously meant for it.
  // Reverts to strict the moment a second human posts.
  if (participants.length <= 1) return 'engage'

  return 'observe'
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
