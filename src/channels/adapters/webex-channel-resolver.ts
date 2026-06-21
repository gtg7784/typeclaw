import type { WebexClient } from 'agent-messenger/webex'

import type { ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function createWebexChannelNameResolver(deps: {
  client: Pick<WebexClient, 'getSpace'>
  ttlMs?: number
  now?: () => number
}): ChannelNameResolver {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const now = deps.now ?? Date.now
  const cache = new Map<string, { value: string; expiresAt: number }>()

  return async (key): Promise<ResolvedChannelNames> => {
    if (key.adapter !== 'webex') return {}
    const cached = cache.get(key.chat)
    if (cached && cached.expiresAt > now()) return { chatName: cached.value }
    try {
      const space = await deps.client.getSpace(key.chat)
      if (space.title === '') return {}
      cache.set(key.chat, { value: space.title, expiresAt: now() + ttlMs })
      return { chatName: space.title }
    } catch {
      return {}
    }
  }
}
