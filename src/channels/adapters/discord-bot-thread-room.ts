import type { InboundMessage } from '@/channels/types'

const DISCORD_API_BASE = 'https://discord.com/api/v10'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

// Discord channel `type` values that are threads (public, private, announcement
// threads). A Discord thread is its OWN channel — a thread message arrives with
// `chat = <thread-channel-id>` and `thread = null`, unlike Slack where the
// thread ts rides `thread`. So the only way to know an inbound is in a thread
// room is to look up the channel's type; the gateway MESSAGE_CREATE event
// carries no thread/parent signal.
const DISCORD_THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12])

export type DiscordChannelMeta = { type?: number; parent_id?: string }

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
  return meta.parent_id !== undefined ? { kind: 'thread', parentChat: meta.parent_id } : { kind: 'thread' }
}

export function createDiscordThreadRoomResolver(
  options: DiscordThreadRoomResolverOptions,
): (channelId: string) => Promise<InboundMessage['room']> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, { value: DiscordChannelMeta; expiresAt: number }>()

  return async (channelId: string): Promise<InboundMessage['room']> => {
    const cached = cache.get(channelId)
    if (cached !== undefined && cached.expiresAt > now()) return discordThreadRoom(cached.value)
    // Only CONFIRMED metadata is cached. A failed lookup ('unknown') is not
    // cached, so the next message on this channel retries rather than pinning
    // the fail-closed state for the whole TTL.
    const meta = await fetchChannelMeta(channelId)
    if (meta !== 'unknown') cache.set(channelId, { value: meta, expiresAt: now() + ttlMs })
    return discordThreadRoom(meta)
  }

  async function fetchChannelMeta(channelId: string): Promise<ChannelMetaLookup> {
    try {
      const response = await fetchImpl(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`, {
        headers: { Authorization: `Bot ${options.token}` },
      })
      if (!response.ok) return 'unknown'
      return (await response.json()) as DiscordChannelMeta
    } catch {
      return 'unknown'
    }
  }
}
