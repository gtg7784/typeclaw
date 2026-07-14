import { describe, expect, test } from 'bun:test'

import type { DiscordClient } from 'agent-messenger/discord'

import { createDiscordChannelResolver } from './discord-channel-resolver'

describe('discord user channel resolver', () => {
  test('resolves and caches channel, guild, and thread-parent metadata through DiscordClient', async () => {
    const calls: string[] = []
    const client = {
      getChannel: async (id: string) => {
        calls.push(`channel:${id}`)
        if (id === '101') return { id, name: 'topic-thread', guild_id: '201', parent_id: '301', type: 11 }
        return { id, name: 'development', guild_id: '201', type: 0 }
      },
      getServer: async (id: string) => {
        calls.push(`server:${id}`)
        return { id, name: 'Example Guild' }
      },
    }
    const resolver = createDiscordChannelResolver({ client })
    const key = { adapter: 'discord' as const, workspace: '201', chat: '101', thread: null }

    expect(await resolver(key)).toEqual({ chatName: 'topic-thread', workspaceName: 'Example Guild' })
    expect(await resolver.resolveRoom('101')).toEqual({
      kind: 'thread',
      parentChat: '301',
      parentChatName: 'development',
    })
    await resolver(key)

    expect(calls).toEqual(['channel:101', 'server:201', 'channel:301'])
  })

  test('keeps IDs usable when server or parent resolution fails', async () => {
    const resolver = createDiscordChannelResolver({
      client: {
        getChannel: async (id: string) => {
          if (id === '101') return { id, name: 'thread', guild_id: '201', parent_id: '301', type: 11 }
          throw new Error('parent unavailable')
        },
        getServer: async () => {
          throw new Error('server unavailable')
        },
      },
    })

    expect(await resolver({ adapter: 'discord', workspace: '201', chat: '101', thread: null })).toEqual({
      chatName: 'thread',
    })
    expect(await resolver.resolveRoom('101')).toEqual({ kind: 'thread', parentChat: '301' })
  })

  test('fails closed without caching when channel metadata lookup is transiently unavailable', async () => {
    let attempts = 0
    const resolver = createDiscordChannelResolver({
      client: {
        getChannel: async (id: string) => {
          attempts += 1
          if (attempts === 1) throw new Error('temporary failure')
          return { id, name: 'general', guild_id: '201', type: 0 }
        },
        getServer: async (id: string) => ({ id, name: 'Example Guild' }),
      },
    })

    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: undefined, parentChecked: true })
    expect(attempts).toBe(2)
  })

  test('rejects malformed Discord IDs before calling the SDK', async () => {
    let calls = 0
    const resolver = createDiscordChannelResolver({
      client: {
        getChannel: async () => {
          calls += 1
          throw new Error('must not run')
        },
        getServer: async () => {
          calls += 1
          throw new Error('must not run')
        },
      },
    })

    for (const id of ['room/1', '0', '01', '18446744073709551616']) {
      await resolver({ adapter: 'discord', workspace: id, chat: id, thread: null })
      expect(await resolver.resolveRoom(id)).toEqual({ kind: 'thread' })
    }
    expect(calls).toBe(0)
  })

  test('treats successful channel metadata with an absent or non-numeric type as transient', async () => {
    let attempts = 0
    const resolver = createDiscordChannelResolver({
      client: {
        getChannel: (async (id: string) => {
          attempts += 1
          if (attempts === 1) return { id, name: 'malformed', guild_id: '201' }
          if (attempts === 2) return { id, name: 'malformed', guild_id: '201', type: '0' }
          return { id, name: 'general', guild_id: '201', type: 0 }
        }) as unknown as DiscordClient['getChannel'],
        getServer: async (id: string) => ({ id, name: 'Example Guild' }),
      },
    })

    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: undefined, parentChecked: true })
    expect(attempts).toBe(3)
  })

  test('keeps a confirmed thread with a missing parent retryable', async () => {
    let attempts = 0
    const resolver = createDiscordChannelResolver({
      client: {
        getChannel: async (id: string) => {
          attempts += 1
          return attempts === 1
            ? { id, name: 'thread', guild_id: '201', type: 11 }
            : { id, name: 'thread', guild_id: '201', type: 11, parent_id: '301' }
        },
        getServer: async (id: string) => ({ id, name: 'Example Guild' }),
      },
    })

    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolver.resolveRoomStatus('101')).toEqual({
      room: { kind: 'thread', parentChat: '301', parentChatName: 'thread' },
      parentChecked: true,
    })
    expect(attempts).toBe(3)
  })

  test('accepts parent_id:null on a normal channel and caches the confirmed non-thread result', async () => {
    let attempts = 0
    const resolver = createDiscordChannelResolver({
      client: {
        getChannel: (async (id: string) => {
          attempts += 1
          return { id, name: 'general', guild_id: '201', type: 0, parent_id: null }
        }) as unknown as DiscordClient['getChannel'],
        getServer: async (id: string) => ({ id, name: 'Example Guild' }),
      },
    })

    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: undefined, parentChecked: true })
    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: undefined, parentChecked: true })
    expect(attempts).toBe(1)
  })

  test('keeps a thread with parent_id:null retryable', async () => {
    let attempts = 0
    const resolver = createDiscordChannelResolver({
      client: {
        getChannel: (async (id: string) => {
          attempts += 1
          return { id, name: 'thread', guild_id: '201', type: 11, parent_id: null }
        }) as unknown as DiscordClient['getChannel'],
        getServer: async (id: string) => ({ id, name: 'Example Guild' }),
      },
    })

    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(await resolver.resolveRoomStatus('101')).toEqual({ room: { kind: 'thread' }, parentChecked: false })
    expect(attempts).toBe(2)
  })
})
