import type { DiscordClient } from 'agent-messenger/discord'

import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export type DiscordChannelResolverOptions = {
  client: Pick<DiscordClient, 'getChannel'>
  now?: () => number
  ttlMs?: number
}

type CacheEntry<T> = { value: T; expiresAt: number }

export function createDiscordChannelResolver(options: DiscordChannelResolverOptions): ChannelNameResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const chatCache = new Map<string, CacheEntry<string>>()

  const fetchCached = async <T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> => {
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) return cached.value
    const value = await fetcher()
    if (value !== null) cache.set(key, { value, expiresAt: now() + ttlMs })
    return value
  }

  return async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    if (key.workspace === '@dm') return {}
    const chatName = await fetchCached(chatCache, key.chat, async () => {
      try {
        const channel = await options.client.getChannel(key.chat)
        return channel.name || null
      } catch {
        return null
      }
    })
    return chatName !== null ? { chatName } : {}
  }
}
