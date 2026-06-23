import type { DiscordClient, DiscordUser } from 'agent-messenger/discord'

const DEFAULT_TTL_MS = 60 * 60 * 1000

export type DiscordAuthorResolverOptions = {
  client: Pick<DiscordClient, 'getUser'>
  now?: () => number
  ttlMs?: number
}

export type DiscordAuthorResolver = {
  resolve: (userId: string) => Promise<string>
}

type CacheEntry = { name: string; expiresAt: number }

export function createDiscordAuthorResolver(options: DiscordAuthorResolverOptions): DiscordAuthorResolver {
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

function pickDisplayName(user: DiscordUser): string | null {
  const candidates = [user.global_name, user.username]
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c
  }
  return null
}
