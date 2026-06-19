import { describe, expect, test } from 'bun:test'

import type { InboundMessage } from '@/channels/types'

import { enrichWebexMessageReference } from './webex-bot-reference'

const inbound: InboundMessage = {
  adapter: 'webex-bot',
  workspace: 'room-1',
  chat: 'room-1',
  thread: null,
  text: 'reply',
  externalMessageId: 'child',
  authorId: 'user-1',
  authorName: 'user@example.com',
  authorIsBot: false,
  isBotMention: false,
  replyToBotMessageId: null,
  mentionsOthers: false,
  replyToOtherMessageId: null,
  isDm: false,
  ts: 0,
}

describe('enrichWebexMessageReference', () => {
  test('adds reply reference context from parent message', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentId: 'parent',
      client: {
        getMessage: async () => ({
          id: 'parent',
          roomId: 'room-1',
          roomType: 'group',
          text: 'parent text',
          personId: 'user-2',
          personEmail: 'other@example.com',
          created: '',
        }),
      },
    })

    expect(enriched.referenceContext).toEqual({
      kind: 'reply',
      sources: [{ adapter: 'webex-bot', authorId: 'user-2', authorName: 'other@example.com', text: 'parent text' }],
    })
  })

  test('swallows parent fetch failures', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentId: 'parent',
      client: {
        getMessage: async () => {
          throw new Error('boom')
        },
      },
    })

    expect(enriched).toEqual(inbound)
  })
})
