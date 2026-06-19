import { describe, expect, test } from 'bun:test'

import { createWebexChannelNameResolver } from './webex-bot-channel-resolver'

describe('createWebexChannelNameResolver', () => {
  test('resolves and caches room titles', async () => {
    let calls = 0
    const resolver = createWebexChannelNameResolver({
      client: {
        getSpace: async (id) => {
          calls++
          return {
            id,
            title: 'Team Room',
            type: 'group',
            isLocked: false,
            lastActivity: '',
            created: '',
            creatorId: '',
          }
        },
      },
      now: () => 1,
    })

    await expect(
      resolver({ adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', thread: null }),
    ).resolves.toEqual({
      chatName: 'Team Room',
    })
    await expect(
      resolver({ adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', thread: null }),
    ).resolves.toEqual({
      chatName: 'Team Room',
    })
    expect(calls).toBe(1)
  })

  test('ignores other adapters', async () => {
    const resolver = createWebexChannelNameResolver({
      client: {
        getSpace: async () => {
          throw new Error('should not fetch')
        },
      },
    })

    await expect(
      resolver({ adapter: 'telegram-bot', workspace: 'telegram', chat: '1', thread: null }),
    ).resolves.toEqual({})
  })
})
