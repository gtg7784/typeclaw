import { describe, expect, test } from 'bun:test'

import type { ChannelParticipant } from '@/agent/session-origin'

import { PARTICIPANTS_MAX_AGE_MS, PARTICIPANTS_MAX_PERSISTED, updateParticipants } from './participants'

describe('updateParticipants', () => {
  test('adds a new participant on first sighting', () => {
    const out = updateParticipants([], 'a1', 'alice', 1000)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      authorId: 'a1',
      authorName: 'alice',
      firstMessageAt: 1000,
      lastMessageAt: 1000,
      messageCount: 1,
    })
  })

  test('bumps lastMessageAt and messageCount on repeat sighting', () => {
    const initial: ChannelParticipant[] = [
      { authorId: 'a1', authorName: 'alice', firstMessageAt: 1000, lastMessageAt: 1000, messageCount: 1 },
    ]
    const out = updateParticipants(initial, 'a1', 'alice', 2000)
    expect(out[0]).toMatchObject({
      authorId: 'a1',
      firstMessageAt: 1000,
      lastMessageAt: 2000,
      messageCount: 2,
    })
  })

  test('updates authorName when display changes', () => {
    const initial: ChannelParticipant[] = [
      { authorId: 'a1', authorName: 'alice', firstMessageAt: 1000, lastMessageAt: 1000, messageCount: 1 },
    ]
    const out = updateParticipants(initial, 'a1', 'alice2', 2000)
    expect(out[0]?.authorName).toBe('alice2')
  })

  test('drops participants older than 7 days on update', () => {
    const old = 0
    const initial: ChannelParticipant[] = [
      { authorId: 'a1', authorName: 'alice', firstMessageAt: old, lastMessageAt: old, messageCount: 5 },
    ]
    const out = updateParticipants(initial, 'b1', 'bob', PARTICIPANTS_MAX_AGE_MS + 1000)
    expect(out.find((p) => p.authorId === 'a1')).toBeUndefined()
    expect(out.find((p) => p.authorId === 'b1')).toBeDefined()
  })

  test('caps to PARTICIPANTS_MAX_PERSISTED, dropping least recent', () => {
    const initial: ChannelParticipant[] = []
    for (let i = 0; i < PARTICIPANTS_MAX_PERSISTED; i++) {
      initial.push({
        authorId: `u${i}`,
        authorName: `u${i}`,
        firstMessageAt: i * 1000,
        lastMessageAt: i * 1000,
        messageCount: 1,
      })
    }
    const out = updateParticipants(initial, 'newcomer', 'newcomer', PARTICIPANTS_MAX_PERSISTED * 1000 + 500)
    expect(out).toHaveLength(PARTICIPANTS_MAX_PERSISTED)
    expect(out.find((p) => p.authorId === 'newcomer')).toBeDefined()
    expect(out.find((p) => p.authorId === 'u0')).toBeUndefined()
  })
})
