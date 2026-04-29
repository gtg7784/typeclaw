import type { ChannelParticipant } from '@/agent/session-origin'

export const PARTICIPANTS_MAX_PERSISTED = 50
export const PARTICIPANTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function updateParticipants(
  current: readonly ChannelParticipant[],
  authorId: string,
  authorName: string,
  now: number,
): ChannelParticipant[] {
  const map = new Map<string, ChannelParticipant>()
  for (const p of current) map.set(p.authorId, p)

  const existing = map.get(authorId)
  if (existing) {
    map.set(authorId, {
      ...existing,
      authorName,
      lastMessageAt: now,
      messageCount: existing.messageCount + 1,
    })
  } else {
    map.set(authorId, {
      authorId,
      authorName,
      firstMessageAt: now,
      lastMessageAt: now,
      messageCount: 1,
    })
  }

  const cutoff = now - PARTICIPANTS_MAX_AGE_MS
  const fresh = Array.from(map.values()).filter((p) => p.lastMessageAt >= cutoff)

  if (fresh.length <= PARTICIPANTS_MAX_PERSISTED) return fresh

  fresh.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
  return fresh.slice(0, PARTICIPANTS_MAX_PERSISTED)
}
