import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

const DISCORD_API_BASE = 'https://discord.com/api/v10'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export type DiscordChannelResolverOptions = {
  token: string
  now?: () => number
  ttlMs?: number
}

type CacheEntry<T> = { value: T; expiresAt: number }

type DiscordChannel = { id?: string; name?: string }
type DiscordGuild = { id?: string; name?: string }

export function createDiscordChannelResolver(options: DiscordChannelResolverOptions): ChannelNameResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS

  const channelCache = new Map<string, CacheEntry<string>>()
  const guildCache = new Map<string, CacheEntry<string>>()

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

    const [chatName, workspaceName] = await Promise.all([
      fetchCached(channelCache, key.chat, () => fetchChannelName(key.chat, options.token)),
      fetchCached(guildCache, key.workspace, () => fetchGuildName(key.workspace, options.token)),
    ])

    const result: ResolvedChannelNames = {}
    if (chatName !== null) result.chatName = chatName
    if (workspaceName !== null) result.workspaceName = workspaceName
    return result
  }
}

async function fetchChannelName(channelId: string, token: string): Promise<string | null> {
  try {
    const response = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`, {
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

async function fetchGuildName(guildId: string, token: string): Promise<string | null> {
  try {
    const response = await fetch(`${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}`, {
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
