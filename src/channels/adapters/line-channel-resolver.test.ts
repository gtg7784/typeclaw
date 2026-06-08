import { describe, expect, test } from 'bun:test'

import type { LineChat } from 'agent-messenger/line'

import { createLineChannelResolver, lineWorkspaceForType } from './line-channel-resolver'

function chat(id: string, type: LineChat['type'], name = ''): LineChat {
  return { chat_id: id, type, display_name: name }
}

describe('lineWorkspaceForType', () => {
  test('maps user to DM, group/room to group, square to square', () => {
    expect(lineWorkspaceForType('user')).toBe('@line-dm')
    expect(lineWorkspaceForType('group')).toBe('@line-group')
    expect(lineWorkspaceForType('room')).toBe('@line-group')
    expect(lineWorkspaceForType('square')).toBe('@line-square')
  })
})

describe('createLineChannelResolver', () => {
  test('classifies chats into buckets after refresh', async () => {
    const resolver = createLineChannelResolver({
      client: {
        getChats: async () => [
          chat('U1', 'user', 'Alice'),
          chat('G1', 'group', 'Team'),
          chat('R1', 'room'),
          chat('S1', 'square', 'OpenChat'),
        ],
      },
    })
    await resolver.refresh()
    expect(resolver.lookupChat('U1')).toEqual({ workspace: '@line-dm', isDm: true })
    expect(resolver.lookupChat('G1')).toEqual({ workspace: '@line-group', isDm: false })
    expect(resolver.lookupChat('R1')).toEqual({ workspace: '@line-group', isDm: false })
    expect(resolver.lookupChat('S1')).toEqual({ workspace: '@line-square', isDm: false })
  })

  test('resolve returns the chat display name', async () => {
    const resolver = createLineChannelResolver({
      client: { getChats: async () => [chat('U1', 'user', 'Alice')] },
    })
    const names = await resolver.resolve({ adapter: 'line', workspace: '@line-dm', chat: 'U1', thread: null })
    expect(names.chatName).toBe('Alice')
  })

  test('returns null for an unknown chat and treats a provisional entry as a strict group', async () => {
    const resolver = createLineChannelResolver({ client: { getChats: async () => [] } })
    await resolver.refresh()
    expect(resolver.lookupChat('X1')).toBeNull()
    resolver.ingestProvisional('X1')
    expect(resolver.lookupChat('X1')).toEqual({ workspace: '@line-group', isDm: false })
  })

  test('treats a stale entry as null so callers refresh', async () => {
    let clock = 1000
    const resolver = createLineChannelResolver({
      client: { getChats: async () => [chat('U1', 'user')] },
      now: () => clock,
      ttlMs: 100,
    })
    await resolver.refresh()
    expect(resolver.lookupChat('U1')).not.toBeNull()
    clock += 200
    expect(resolver.lookupChat('U1')).toBeNull()
  })
})
