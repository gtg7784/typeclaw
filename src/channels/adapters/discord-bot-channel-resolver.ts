import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

import { isDiscordSnowflake } from './discord-id'
import { DiscordResolverCache } from './discord-resolver-cache'

const DISCORD_API_BASE = 'https://discord.com/api/v10'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export type DiscordChannelResolverOptions = {
  token: string
  now?: () => number
  ttlMs?: number
  maxCacheEntries?: number
  fetchImpl?: typeof fetch
}

type DiscordChannel = { id?: string; name?: string }
type DiscordGuild = { id?: string; name?: string }

export function createDiscordChannelResolver(options: DiscordChannelResolverOptions): ChannelNameResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const fetchImpl = options.fetchImpl ?? fetch

  const channelCache = new DiscordResolverCache<string>(options.maxCacheEntries)
  const guildCache = new DiscordResolverCache<string>(options.maxCacheEntries)

  const fetchCached = async <T>(
    cache: DiscordResolverCache<T>,
    key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> => {
    const currentTime = now()
    const cached = cache.get(key, currentTime)
    if (cached !== undefined) return cached
    const value = await fetcher()
    if (value !== null) {
      const fetchedAt = now()
      cache.set(key, value, fetchedAt + ttlMs, fetchedAt)
    }
    return value
  }

  return async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    if (key.workspace === '@dm') return {}

    const [chatName, workspaceName] = await Promise.all([
      isDiscordSnowflake(key.chat)
        ? fetchCached(channelCache, key.chat, () => fetchChannelName(key.chat, options.token, fetchImpl))
        : Promise.resolve(null),
      isDiscordSnowflake(key.workspace)
        ? fetchCached(guildCache, key.workspace, () => fetchGuildName(key.workspace, options.token, fetchImpl))
        : Promise.resolve(null),
    ])

    const result: ResolvedChannelNames = {}
    if (chatName !== null) result.chatName = chatName
    if (workspaceName !== null) result.workspaceName = workspaceName
    return result
  }
}

async function fetchChannelName(channelId: string, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`, {
      headers: { Authorization: `Bot ${token}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as DiscordChannel
    if (typeof body.name !== 'string' || body.name === '') return null
    return body.name
  } catch {
    return null
  }
}

async function fetchGuildName(guildId: string, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}`, {
      headers: { Authorization: `Bot ${token}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as DiscordGuild
    if (typeof body.name !== 'string' || body.name === '') return null
    return body.name
  } catch {
    return null
  }
}
