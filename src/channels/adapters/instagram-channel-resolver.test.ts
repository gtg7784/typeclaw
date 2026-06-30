import { describe, expect, test } from 'bun:test'

import type { InstagramChatSummary } from 'agent-messenger/instagram'

import { createInstagramChannelResolver } from './instagram-channel-resolver'

function chat(overrides: Partial<InstagramChatSummary>): InstagramChatSummary {
  return {
    id: 'T1',
    name: 'Alice',
    type: 'private',
    is_group: false,
    participant_count: 2,
    unread_count: 0,
    ...overrides,
  }
}

describe('createInstagramChannelResolver', () => {
  test('buckets DMs and groups', async () => {
    const resolver = createInstagramChannelResolver({
      client: { listChats: async () => [chat({ id: 'D1' }), chat({ id: 'G1', type: 'group', is_group: true })] },
    })
    await resolver.refresh()
    expect(resolver.lookupChat('D1')).toEqual({ workspace: '@instagram-dm', isDm: true })
    expect(resolver.lookupChat('G1')).toEqual({ workspace: '@instagram-group', isDm: false })
  })

  test('provisional ingest defaults to group', () => {
    const resolver = createInstagramChannelResolver({ client: { listChats: async () => [] } })
    resolver.ingestProvisional('T_new')
    expect(resolver.lookupChat('T_new')).toEqual({ workspace: '@instagram-group', isDm: false })
  })

  test('refreshes stale cache on resolve', async () => {
    let now = 0
    let calls = 0
    const resolver = createInstagramChannelResolver({
      now: () => now,
      ttlMs: 10,
      client: {
        listChats: async () => {
          calls++
          return [chat({ id: 'D1', name: `Alice ${calls}` })]
        },
      },
    })
    await resolver.refresh()
    now = 11
    expect(
      await resolver.resolve({ adapter: 'instagram', workspace: '@instagram-dm', chat: 'D1', thread: null }),
    ).toEqual({
      chatName: 'Alice 2',
    })
  })
})
