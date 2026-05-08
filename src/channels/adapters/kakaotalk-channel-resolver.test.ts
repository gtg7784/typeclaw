import { describe, expect, test } from 'bun:test'

import type { KakaoChat, KakaoTalkClient } from './agent-messenger-kakaotalk-shim'
import { createKakaoChannelResolver } from './kakaotalk-channel-resolver'

// Modern KakaoTalk LOCO type codes — t=11 for normal 1:1 DMs and t=10 for
// normal groups. The earlier `t=0/1/2` fixtures matched a stale assumption
// and let the previous classifier pass even though it misclassified every
// real-world DM as `@kakao-group`.
const dmChat = (id: string, name: string): KakaoChat => ({
  chat_id: id,
  type: 11,
  display_name: name,
  active_members: 2,
  unread_count: 0,
  last_message: null,
})

const groupChat = (id: string, name: string): KakaoChat => ({
  chat_id: id,
  type: 10,
  display_name: name,
  active_members: 5,
  unread_count: 0,
  last_message: null,
})

const fakeClient = (chats: KakaoChat[]): Pick<KakaoTalkClient, 'getChats'> => ({
  getChats: async () => chats,
})

describe('createKakaoChannelResolver', () => {
  test('lookupChat returns null for unknown chats', () => {
    const resolver = createKakaoChannelResolver({ client: fakeClient([]) })
    expect(resolver.lookupChat('999')).toBeNull()
  })

  test('lookupChat returns workspace + isDm after refresh', async () => {
    const resolver = createKakaoChannelResolver({
      client: fakeClient([dmChat('111', 'Alice'), groupChat('222', 'Team')]),
    })
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true })
    expect(resolver.lookupChat('222')).toEqual({ workspace: '@kakao-group', isDm: false })
  })

  test('lookupChat returns null for stale entries (TTL expired)', async () => {
    let now = 1000
    const resolver = createKakaoChannelResolver({
      client: fakeClient([dmChat('111', 'Alice')]),
      now: () => now,
      ttlMs: 100,
    })
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true })

    // Advance past the TTL. lookupChat must NOT keep returning the stale
    // entry — callers depend on null to trigger a refresh.
    now += 200
    expect(resolver.lookupChat('111')).toBeNull()
  })

  test('resolve refreshes the cache when entries are stale', async () => {
    let now = 1000
    let chats: KakaoChat[] = [dmChat('111', 'Alice')]
    const resolver = createKakaoChannelResolver({
      client: { getChats: async () => chats },
      now: () => now,
      ttlMs: 100,
    })
    await resolver.refresh()

    chats = [dmChat('111', 'Alice updated')]
    now += 200

    const result = await resolver.resolve({ adapter: 'kakaotalk', workspace: '@kakao-dm', chat: '111', thread: null })
    expect(result.chatName).toBe('Alice updated')
  })

  test('refresh coalesces concurrent calls', async () => {
    let calls = 0
    const slowClient: Pick<KakaoTalkClient, 'getChats'> = {
      getChats: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 20))
        return [dmChat('111', 'Alice')]
      },
    }
    const resolver = createKakaoChannelResolver({ client: slowClient })
    await Promise.all([resolver.refresh(), resolver.refresh(), resolver.refresh()])
    expect(calls).toBe(1)
  })

  test('reflects chat-type changes after a fresh refresh', async () => {
    let now = 1000
    let chats: KakaoChat[] = [dmChat('111', 'Alice')]
    const resolver = createKakaoChannelResolver({
      client: { getChats: async () => chats },
      now: () => now,
      ttlMs: 100,
    })
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true })

    chats = [groupChat('111', 'Alice, Bob')]
    now += 200
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-group', isDm: false })
  })
})
