import type { InboundMessage } from '@/channels/types'

import { isDiscordSnowflake } from './discord-id'
import { DiscordResolverCache } from './discord-resolver-cache'

const DISCORD_API_BASE = 'https://discord.com/api/v10'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

// Discord channel `type` values that are threads (public, private, announcement
// threads). A Discord thread is its OWN channel — a thread message arrives with
// `chat = <thread-channel-id>` and `thread = null`, unlike Slack where the
// thread ts rides `thread`. So the only way to know an inbound is in a thread
// room is to look up the channel's type; the gateway MESSAGE_CREATE event
// carries no thread/parent signal.
const DISCORD_THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12])

export type DiscordChannelMeta = { type?: number; parent_id?: string | null }

// The lookup has THREE outcomes, and the failure case must not be conflated
// with a confirmed non-thread channel:
//   - a channel object → we know the type (thread or not)
//   - 'unknown' → the fetch failed (network / non-OK / rate limit); we cannot
//     tell, so downstream must fail closed rather than assume "normal channel".
type ChannelMetaLookup = DiscordChannelMeta | 'unknown'

export type DiscordThreadRoomResolverOptions = {
  token: string
  fetchImpl?: typeof fetch
  now?: () => number
  ttlMs?: number
  maxCacheEntries?: number
}

export type DiscordThreadRoomStatus = { room: InboundMessage['room']; parentChecked: boolean }
export type DiscordThreadRoomResolver = ((channelId: string) => Promise<InboundMessage['room']>) & {
  resolveStatus(channelId: string): Promise<DiscordThreadRoomStatus>
}

// Maps a lookup outcome to the room signal. A confirmed thread carries its
// parent for membership scoping; a confirmed non-thread returns undefined (the
// solo fallback may apply). An 'unknown' fetch failure returns a bare thread
// room WITHOUT parentChat: it fails the engagement gate closed (so the bot
// won't butt into a possibly-thread it can't classify) while still resolving
// membership against the thread's own channel — the same conservative posture
// as a private thread whose parent we can't read.
export function discordThreadRoom(meta: ChannelMetaLookup): InboundMessage['room'] {
  if (meta === 'unknown') return { kind: 'thread' }
  if (meta.type === undefined || !DISCORD_THREAD_CHANNEL_TYPES.has(meta.type)) return undefined
  return meta.parent_id != null ? { kind: 'thread', parentChat: meta.parent_id } : { kind: 'thread' }
}

export function createDiscordThreadRoomResolver(options: DiscordThreadRoomResolverOptions): DiscordThreadRoomResolver {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new DiscordResolverCache<DiscordChannelMeta>(options.maxCacheEntries)

  const resolve = (async (channelId: string): Promise<InboundMessage['room']> =>
    (await resolve.resolveStatus(channelId)).room) as DiscordThreadRoomResolver

  resolve.resolveStatus = async (channelId: string): Promise<DiscordThreadRoomStatus> => {
    if (!isDiscordSnowflake(channelId)) return { room: { kind: 'thread' }, parentChecked: false }
    const currentTime = now()
    const cached = cache.get(channelId, currentTime)
    if (cached !== undefined) {
      return { room: discordThreadRoom(cached), parentChecked: true }
    }
    // Only CONFIRMED metadata is cached. A failed lookup ('unknown') is not
    // cached, so the next message on this channel retries rather than pinning
    // the fail-closed state for the whole TTL.
    const meta = await fetchChannelMeta(channelId)
    const room = discordThreadRoom(meta)
    const parentChecked = meta !== 'unknown' && (room?.kind !== 'thread' || room.parentChat != null)
    if (meta !== 'unknown' && parentChecked) {
      const fetchedAt = now()
      cache.set(channelId, meta, fetchedAt + ttlMs, fetchedAt)
    }
    return { room, parentChecked }
  }

  return resolve

  async function fetchChannelMeta(channelId: string): Promise<ChannelMetaLookup> {
    try {
      const response = await fetchImpl(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`, {
        headers: { Authorization: `Bot ${options.token}` },
      })
      if (!response.ok) return 'unknown'
      const body: unknown = await response.json()
      if (!validChannelMetadata(body)) return 'unknown'
      return body
    } catch {
      return 'unknown'
    }
  }
}

function validChannelMetadata(value: unknown): value is DiscordChannelMeta & { type: number } {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  if (typeof value.type !== 'number' || !Number.isInteger(value.type) || value.type < 0) return false
  if ('parent_id' in value && value.parent_id != null) {
    if (typeof value.parent_id !== 'string' || !isDiscordSnowflake(value.parent_id)) return false
  }
  return true
}
