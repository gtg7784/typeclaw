import type { SlackClient, SlackUser } from 'agent-messenger/slack'

const DEFAULT_TTL_MS = 60 * 60 * 1000

export type SlackAuthorResolverOptions = {
  client: Pick<SlackClient, 'getUser'>
  now?: () => number
  ttlMs?: number
}

export type SlackAuthorResolver = {
  resolve: (userId: string) => Promise<string>
}

type CacheEntry = { name: string; expiresAt: number }

export function createSlackAuthorResolver(options: SlackAuthorResolverOptions): SlackAuthorResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<string>>()

  const resolve = async (userId: string): Promise<string> => {
    const cached = cache.get(userId)
    if (cached && cached.expiresAt > now()) return cached.name
    const existing = inflight.get(userId)
    if (existing) return existing
    const promise = options.client
      .getUser(userId)
      .then((user) => pickDisplayName(user) ?? userId)
      .catch(() => userId)
      .then((name) => {
        if (name !== userId) cache.set(userId, { name, expiresAt: now() + ttlMs })
        return name
      })
      .finally(() => {
        inflight.delete(userId)
      })
    inflight.set(userId, promise)
    return promise
  }

  return { resolve }
}

// Identity fields only. `profile.status_text` is presence text ("In a meeting"),
// not a name, so it must never stand in for the author's display name.
function pickDisplayName(user: SlackUser): string | null {
  const candidates = [user.real_name, user.name]
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c
  }
  return null
}
