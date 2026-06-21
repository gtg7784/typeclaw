import { describe, expect, test } from 'bun:test'

import type { InboundMessage } from '@/channels/types'

import { enrichWebexMessageReference } from './webex-reference'

const inbound: InboundMessage = {
  adapter: 'webex',
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

function parentFrom(personRef: string, text = 'parent text') {
  return async () => ({
    id: 'parent-blob',
    ref: 'parent',
    roomId: 'room-blob-1',
    roomRef: 'room-1',
    roomType: 'group' as const,
    text,
    personId: `${personRef}-blob`,
    personRef,
    personEmail: `${personRef}@example.com`,
    created: '',
  })
}

describe('enrichWebexMessageReference', () => {
  test('adds reply reference context from parent refs', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: { getMessage: parentFrom('user-2', 'parent text') },
    })

    expect(enriched.referenceContext).toEqual({
      kind: 'reply',
      sources: [{ adapter: 'webex', authorId: 'user-2', authorName: 'user-2@example.com', text: 'parent text' }],
    })
  })

  test('marks a reply to a bot-authored parent ref as bot-directed', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: { getMessage: parentFrom('bot-1') },
    })

    expect(enriched.replyToBotMessageId).toBe('parent')
    expect(enriched.replyToOtherMessageId).toBeNull()
  })
})
