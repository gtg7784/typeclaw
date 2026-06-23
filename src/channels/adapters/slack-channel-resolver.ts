import type { SlackClient } from 'agent-messenger/slack'

import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export type SlackChannelResolverOptions = {
  client: Pick<SlackClient, 'getChannel'>
  teamNameRef?: () => string | null
  now?: () => number
  ttlMs?: number
}

type CacheEntry<T> = { value: T; expiresAt: number }

export function createSlackChannelResolver(options: SlackChannelResolverOptions): ChannelNameResolver {
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
    const workspaceName = options.teamNameRef?.() ?? null
    const result: ResolvedChannelNames = {}
    if (chatName !== null) result.chatName = chatName
    if (workspaceName !== null) result.workspaceName = workspaceName
    return result
  }
}
