import type { ChannelParticipant } from '@/agent/session-origin'

export const PARTICIPANTS_MAX_PERSISTED = 50
export const PARTICIPANTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function updateParticipants(
  current: readonly ChannelParticipant[],
  authorId: string,
  authorName: string,
  now: number,
  isBot: boolean = false,
): ChannelParticipant[] {
  const map = new Map<string, ChannelParticipant>()
  for (const p of current) map.set(p.authorId, p)

  const existing = map.get(authorId)
  if (existing) {
    // Once an author is flagged as a bot, keep that flag sticky. A peer bot
    // briefly behaving like a human (e.g. an admin posting via the bot's
    // webhook from a DM) shouldn't reset the classification — engagement
    // semantics rely on this being stable across a participant's lifetime.
    map.set(authorId, {
      ...existing,
      authorName,
      lastMessageAt: now,
      messageCount: existing.messageCount + 1,
      isBot: existing.isBot === true || isBot,
    })
  } else {
    map.set(authorId, {
      authorId,
      authorName,
      firstMessageAt: now,
      lastMessageAt: now,
      messageCount: 1,
      isBot,
    })
  }

  const cutoff = now - PARTICIPANTS_MAX_AGE_MS
  const fresh = Array.from(map.values()).filter((p) => p.lastMessageAt >= cutoff)

  if (fresh.length <= PARTICIPANTS_MAX_PERSISTED) return fresh

  fresh.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
  return fresh.slice(0, PARTICIPANTS_MAX_PERSISTED)
}
