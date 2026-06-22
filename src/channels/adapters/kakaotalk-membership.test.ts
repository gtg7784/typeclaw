import { describe, expect, test } from 'bun:test'

import type { KakaoMember } from 'agent-messenger/kakaotalk'

import type { ChannelKey } from '@/channels/types'

import { createKakaoMembershipResolver } from './kakaotalk-membership'

const member = (user_id: string): KakaoMember => ({
  user_id,
  nickname: `name-${user_id}`,
  profile_image_url: null,
  full_profile_image_url: null,
  original_profile_image_url: null,
  status_message: null,
  country_iso: null,
  user_type: 100,
  open_token: null,
  open_profile_link_id: null,
  open_permission: null,
})

const groupKey: ChannelKey = { adapter: 'kakaotalk', workspace: '@kakao-group', chat: 'chat-1', thread: null }

const logger = () => ({ warn: () => {} })

describe('createKakaoMembershipResolver', () => {
  test('counts every roster member except the agent as a human', async () => {
    // given: a group of the agent (self) plus three humans
    const resolver = createKakaoMembershipResolver({
      client: { getMembers: async () => [member('self'), member('m1'), member('m2'), member('m3')] },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 123,
    })

    // when
    const result = await resolver(groupKey)

    // then: self is excluded; the group reports >1 human so engagement stays strict
    expect(result).toEqual({
      humans: 3,
      bots: 1,
      fetchedAt: 123,
      truncated: false,
      humanMemberIds: ['m1', 'm2', 'm3'],
    })
  })

  test('a real group never collapses to the solo-human fallback (regression)', async () => {
    // given: the incident shape — a multi-member group where only one human
    // has posted; the roster must still report >1 human
    const resolver = createKakaoMembershipResolver({
      client: { getMembers: async () => [member('self'), member('mom'), member('son')] },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 0,
    })

    const result = await resolver(groupKey)

    expect(result).not.toHaveProperty('kind')
    if ('humans' in result) expect(result.humans).toBeGreaterThan(1)
  })

  test('dedupes members listed by both GETMEM and CHATONROOM', async () => {
    const resolver = createKakaoMembershipResolver({
      client: { getMembers: async () => [member('self'), member('m1'), member('m1'), member('m2')] },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 5,
    })

    const result = await resolver(groupKey)

    expect(result).toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 5,
      truncated: false,
      humanMemberIds: ['m1', 'm2'],
    })
  })

  test('reports a 1:1 chat as exactly one human (self excluded)', async () => {
    const resolver = createKakaoMembershipResolver({
      client: { getMembers: async () => [member('self'), member('peer')] },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 1,
    })

    expect(await resolver(groupKey)).toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 1,
      truncated: false,
      humanMemberIds: ['peer'],
    })
  })

  test('fails transient before login resolves a self id', async () => {
    let called = false
    const resolver = createKakaoMembershipResolver({
      client: {
        getMembers: async () => {
          called = true
          return []
        },
      },
      selfUserIdRef: () => null,
      logger: logger(),
    })

    expect(await resolver(groupKey)).toEqual({ kind: 'transient' })
    expect(called).toBe(false)
  })

  test('fails transient when the roster fetch throws', async () => {
    const resolver = createKakaoMembershipResolver({
      client: {
        getMembers: async () => {
          throw new Error('GETMEM failed')
        },
      },
      selfUserIdRef: () => 'self',
      logger: logger(),
    })

    expect(await resolver(groupKey)).toEqual({ kind: 'transient' })
  })

  test('rejects a non-kakaotalk key as a permanent failure', async () => {
    const resolver = createKakaoMembershipResolver({
      client: { getMembers: async () => [] },
      selfUserIdRef: () => 'self',
      logger: logger(),
    })

    expect(await resolver({ adapter: 'discord-bot', workspace: 'w', chat: 'c', thread: null })).toEqual({
      kind: 'permanent',
    })
  })
})
