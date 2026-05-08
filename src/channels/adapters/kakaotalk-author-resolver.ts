import type { KakaoChat, KakaoTalkClient } from './agent-messenger-kakaotalk-shim'

const DEFAULT_TTL_MS = 5 * 60 * 1000

export type KakaoAuthorResolver = {
  resolve: (authorId: string, chatId: string) => Promise<string>
  prime: (chats: readonly KakaoChat[]) => void
}

export type KakaoAuthorResolverOptions = {
  client: Pick<KakaoTalkClient, 'getChats'>
  now?: () => number
  ttlMs?: number
}

// KakaoTalk's LOCO protocol surfaces an author_id (numeric user_id) on every
// inbound message but no display name. Names are only available indirectly
// through KakaoChat.display_name, which is a comma-joined list of member
// names for group chats and the counterpart's name for 1:1 chats. We use
// this best-effort heuristic so the agent sees a human-readable author
// string rather than a bare numeric id.
//
// 1:1 chat: display_name is the other party's name → use it for any
// author_id that isn't ours.
// Group/open: we cannot deterministically split "Alice, Bob, Carol" back
// into per-author entries, so the resolver falls back to the raw
// author_id. The agent layer can override via configured aliases.
export function createKakaoAuthorResolver(options: KakaoAuthorResolverOptions): KakaoAuthorResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const dmCounterpartByChat = new Map<string, { name: string; expiresAt: number }>()
  let lastRefreshAt = 0

  const prime = (chats: readonly KakaoChat[]): void => {
    const expiresAt = now() + ttlMs
    for (const chat of chats) {
      if (chat.type === 0 && chat.display_name !== null && chat.display_name !== '') {
        dmCounterpartByChat.set(chat.chat_id, { name: chat.display_name, expiresAt })
      }
    }
    lastRefreshAt = now()
  }

  const refresh = async (): Promise<void> => {
    try {
      const chats = await options.client.getChats({ all: true })
      prime(chats)
    } catch {
      // Author resolution is best-effort; a network blip falls back to
      // returning the raw id rather than blocking message routing.
    }
  }

  const resolve = async (authorId: string, chatId: string): Promise<string> => {
    const cached = dmCounterpartByChat.get(chatId)
    if (cached !== undefined && cached.expiresAt > now()) return cached.name
    if (now() - lastRefreshAt > ttlMs) await refresh()
    const fresh = dmCounterpartByChat.get(chatId)
    if (fresh !== undefined) return fresh.name
    return authorId
  }

  return { resolve, prime }
}
