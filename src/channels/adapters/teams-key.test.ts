import { describe, expect, test } from 'bun:test'

import { decodeTeamsConversationKey, encodeTeamsChannelKey, encodeTeamsChatKey } from './teams-key'

describe('teams conversation key codec', () => {
  test('round-trips a chat key', () => {
    const key = encodeTeamsChatKey('19:oneonone@thread.v2')
    expect(key).toBe('chat:19:oneonone@thread.v2')
    expect(decodeTeamsConversationKey(key)).toEqual({ kind: 'chat', chatId: '19:oneonone@thread.v2' })
  })

  test('round-trips a channel key even though channelId contains colons', () => {
    const key = encodeTeamsChannelKey('team-guid', '19:abc@thread.tacv2')
    expect(key).toBe('channel:team-guid:19:abc@thread.tacv2')
    // splitting on the FIRST colon keeps the colon-bearing channelId intact
    expect(decodeTeamsConversationKey(key)).toEqual({
      kind: 'channel',
      teamId: 'team-guid',
      channelId: '19:abc@thread.tacv2',
    })
  })

  test('returns null for an empty chat id', () => {
    expect(decodeTeamsConversationKey('chat:')).toBeNull()
  })

  test('returns null for a channel key missing a channelId', () => {
    expect(decodeTeamsConversationKey('channel:team-guid')).toBeNull()
    expect(decodeTeamsConversationKey('channel:team-guid:')).toBeNull()
    expect(decodeTeamsConversationKey('channel::19:abc')).toBeNull()
  })

  test('returns null for an unknown prefix', () => {
    expect(decodeTeamsConversationKey('team-guid/channel')).toBeNull()
    expect(decodeTeamsConversationKey('')).toBeNull()
  })
})
