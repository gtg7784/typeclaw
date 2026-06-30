import type { InstagramChatSummary } from 'agent-messenger/instagram'

import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const CHAT_FETCH_LIMIT = 500

export type InstagramWorkspace = '@instagram-dm' | '@instagram-group'

export function instagramWorkspaceForChat(chat: Pick<InstagramChatSummary, 'type' | 'is_group'>): InstagramWorkspace {
  return chat.type === 'private' && !chat.is_group ? '@instagram-dm' : '@instagram-group'
}

export type InstagramChatLookupValue = {
  workspace: InstagramWorkspace
  isDm: boolean
}

export type InstagramChannelResolver = {
  resolve: ChannelNameResolver
  lookupChat: (chatId: string) => InstagramChatLookupValue | null
  refresh: () => Promise<void>
  // Inbound events can arrive before listChats() surfaces the thread. Default
  // provisional entries to the stricter group bucket until a real refresh can
  // prove the chat is a DM.
  ingestProvisional: (chatId: string) => void
}

export type InstagramChannelResolverOptions = {
  client: { listChats(limit?: number): Promise<InstagramChatSummary[]> }
  now?: () => number
  ttlMs?: number
  logger?: { warn: (msg: string) => void }
}

type Entry = {
  workspace: InstagramWorkspace
  isDm: boolean
  chatName: string | null
  expiresAt: number
}

export function createInstagramChannelResolver(options: InstagramChannelResolverOptions): InstagramChannelResolver {
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
      const chats = await options.client.listChats(CHAT_FETCH_LIMIT)
      const expiresAt = now() + ttlMs
      for (const chat of chats) ingest(chat, expiresAt)
    } catch (err) {
      options.logger?.warn(`[instagram] channel resolver refresh failed: ${describe(err)}`)
    }
  }

  const ingest = (chat: InstagramChatSummary, expiresAt: number): void => {
    const workspace = instagramWorkspaceForChat(chat)
    cache.set(chat.id, {
      workspace,
      isDm: workspace === '@instagram-dm',
      chatName: chat.name === '' ? null : chat.name,
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

  const lookupChat = (chatId: string): InstagramChatLookupValue | null => {
    const entry = cache.get(chatId)
    if (entry === undefined || entry.expiresAt <= now()) return null
    return { workspace: entry.workspace, isDm: entry.isDm }
  }

  const ingestProvisional = (chatId: string): void => {
    const existing = cache.get(chatId)
    if (existing !== undefined && existing.expiresAt > now()) return
    cache.set(chatId, {
      workspace: '@instagram-group',
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
