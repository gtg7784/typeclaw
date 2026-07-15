import type { DiscordClient } from 'agent-messenger/discord'

import type { ChannelKey, ChannelNameResolver, InboundMessage, ResolvedChannelNames } from '@/channels/types'

import { isDiscordSnowflake } from './discord-id'
import { DiscordResolverCache } from './discord-resolver-cache'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DISCORD_THREAD_TYPES = new Set([10, 11, 12])

export type DiscordChannelResolverOptions = {
  client: Pick<DiscordClient, 'getChannel' | 'getServer'>
  now?: () => number
  ttlMs?: number
  maxCacheEntries?: number
}

export type DiscordChannelResolver = ChannelNameResolver & {
  resolveRoom(chatId: string): Promise<InboundMessage['room']>
  resolveRoomStatus(chatId: string): Promise<{ room: InboundMessage['room']; parentChecked: boolean }>
}

type DiscordChannelInfo = Awaited<ReturnType<DiscordClient['getChannel']>>

export function createDiscordChannelResolver(options: DiscordChannelResolverOptions): DiscordChannelResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const channelCache = new DiscordResolverCache<DiscordChannelInfo>(options.maxCacheEntries)
  const guildCache = new DiscordResolverCache<string>(options.maxCacheEntries)

  const fetchChannel = async (channelId: string): Promise<DiscordChannelInfo | null> =>
    await fetchCached(channelCache, channelId, async () => {
      if (!isDiscordSnowflake(channelId)) return null
      try {
        const channel = await options.client.getChannel(channelId)
        return validChannelMetadata(channel) ? channel : null
      } catch (error) {
        void error
        return null
      }
    })

  const resolve = (async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    if (key.workspace === '@dm') return {}
    const [channel, workspaceName] = await Promise.all([
      fetchChannel(key.chat),
      key.workspace === '' || !isDiscordSnowflake(key.workspace)
        ? Promise.resolve(null)
        : fetchCached(guildCache, key.workspace, async () => {
            try {
              const guild = await options.client.getServer(key.workspace)
              return guild.name || null
            } catch (error) {
              void error
              return null
            }
          }),
    ])
    return {
      ...(channel?.name ? { chatName: channel.name } : {}),
      ...(workspaceName !== null ? { workspaceName } : {}),
    }
  }) as DiscordChannelResolver

  resolve.resolveRoomStatus = async (
    chatId: string,
  ): Promise<{ room: InboundMessage['room']; parentChecked: boolean }> => {
    if (!isDiscordSnowflake(chatId)) return { room: { kind: 'thread' }, parentChecked: false }
    const channel = await fetchChannel(chatId)
    if (channel === null) return { room: { kind: 'thread' }, parentChecked: false }
    if (!DISCORD_THREAD_TYPES.has(channel.type)) return { room: undefined, parentChecked: true }
    if (channel.parent_id == null || !isDiscordSnowflake(channel.parent_id)) {
      channelCache.delete(chatId)
      return { room: { kind: 'thread' }, parentChecked: false }
    }
    const parent = await fetchChannel(channel.parent_id)
    return {
      room: {
        kind: 'thread',
        parentChat: channel.parent_id,
        ...(parent?.name ? { parentChatName: parent.name } : {}),
      },
      parentChecked: true,
    }
  }
  resolve.resolveRoom = async (chatId: string) => (await resolve.resolveRoomStatus(chatId)).room

  return resolve

  async function fetchCached<T>(
    cache: DiscordResolverCache<T>,
    key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> {
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
}

function validChannelMetadata(channel: DiscordChannelInfo): boolean {
  if (!Number.isInteger(channel.type) || channel.type < 0) return false
  if (channel.parent_id != null && !isDiscordSnowflake(channel.parent_id)) return false
  if (channel.guild_id !== undefined && !isDiscordSnowflake(channel.guild_id)) return false
  return true
}
