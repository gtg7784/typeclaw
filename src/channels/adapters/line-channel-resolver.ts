import type { LineChat, LineClient } from 'agent-messenger/line'

import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

const DEFAULT_TTL_MS = 5 * 60 * 1000

// LINE's chat list is fetched in a bounded page; there is no `{ all: true }`
// equivalent the way KakaoTalk has. This cap is generous for a personal
// account but keeps the GETCHATS payload bounded.
const CHAT_FETCH_LIMIT = 500

export type LineWorkspace = '@line-dm' | '@line-group' | '@line-square'

// `user` is a 1:1 DM; `group` and `room` are both multi-party invite chats
// (LINE's legacy "room" vs modern "group" distinction is immaterial to
// engagement, so they share a bucket); `square` is an OpenChat-style public
// community, kept separate because it is the most public surface and least-
// privilege rules want to target it on its own.
export function lineWorkspaceForType(type: LineChat['type']): LineWorkspace {
  if (type === 'user') return '@line-dm'
  if (type === 'square') return '@line-square'
  return '@line-group'
}

export type LineChatLookupValue = {
  workspace: LineWorkspace
  isDm: boolean
}

export type LineChannelResolver = {
  resolve: ChannelNameResolver
  lookupChat: (chatId: string) => LineChatLookupValue | null
  refresh: () => Promise<void>
  // Register a chat learned from an inbound push event when `refresh()` did
  // not surface it (a new chat that hasn't propagated to GETCHATS yet).
  // Provisional entries default to @line-group — the strictest multi-party
  // bucket — so allow-rule enforcement stays conservative until the next real
  // refresh upgrades the entry to its authoritative type.
  ingestProvisional: (chatId: string) => void
}

export type LineChannelResolverOptions = {
  client: Pick<LineClient, 'getChats'>
  now?: () => number
  ttlMs?: number
  logger?: { warn: (msg: string) => void }
}

type Entry = {
  workspace: LineWorkspace
  isDm: boolean
  chatName: string | null
  expiresAt: number
}

export function createLineChannelResolver(options: LineChannelResolverOptions): LineChannelResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, Entry>()
  let inflight: Promise<void> | null = null

  const refresh = async (): Promise<void> => {
    if (inflight !== null) {
      await inflight
      return
    }
    const promise = loadAll().finally(() => {
      inflight = null
    })
    inflight = promise
    await promise
  }

  const loadAll = async (): Promise<void> => {
    try {
      const chats = await options.client.getChats({ limit: CHAT_FETCH_LIMIT })
      const expiresAt = now() + ttlMs
      for (const chat of chats) ingest(chat, expiresAt)
    } catch (err) {
      options.logger?.warn(`[line] channel resolver refresh failed: ${describe(err)}`)
    }
  }

  const ingest = (chat: LineChat, expiresAt: number): void => {
    const workspace = lineWorkspaceForType(chat.type)
    cache.set(chat.chat_id, {
      workspace,
      isDm: chat.type === 'user',
      chatName: chat.display_name === '' ? null : chat.display_name,
      expiresAt,
    })
  }

  const resolve: ChannelNameResolver = async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    const entry = cache.get(key.chat)
    if (entry === undefined || entry.expiresAt <= now()) await refresh()
    const fresh = cache.get(key.chat)
    if (fresh === undefined) return {}
    const result: ResolvedChannelNames = {}
    if (fresh.chatName !== null && fresh.chatName !== '') result.chatName = fresh.chatName
    return result
  }

  // Sync lookup. Returns null when the entry is missing OR stale; callers MUST
  // treat null as "refresh needed", not "unknown forever" — the adapter awaits
  // refresh() and re-checks before dropping a message as unknown_chat.
  const lookupChat = (chatId: string): LineChatLookupValue | null => {
    const entry = cache.get(chatId)
    if (entry === undefined || entry.expiresAt <= now()) return null
    return { workspace: entry.workspace, isDm: entry.isDm }
  }

  const ingestProvisional = (chatId: string): void => {
    const existing = cache.get(chatId)
    if (existing !== undefined && existing.expiresAt > now()) return
    cache.set(chatId, {
      workspace: '@line-group',
      isDm: false,
      chatName: null,
      expiresAt: now() + ttlMs,
    })
  }

  return { resolve, lookupChat, refresh, ingestProvisional }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
