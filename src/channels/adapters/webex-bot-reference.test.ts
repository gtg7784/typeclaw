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

function parentFrom(personId: string, text = 'parent text') {
  return async () => ({
    id: 'parent-blob',
    ref: 'parent',
    roomId: 'room-blob-1',
    roomRef: 'room-1',
    roomType: 'group' as const,
    text,
    personId: `${personId}-blob`,
    personRef: personId,
    personEmail: `${personId}@example.com`,
    created: '',
  })
}

describe('enrichWebexMessageReference', () => {
  test('adds reply reference context from parent message', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: { getMessage: parentFrom('user-2', 'parent text') },
    })

    expect(enriched.referenceContext).toEqual({
      kind: 'reply',
      sources: [{ adapter: 'webex-bot', authorId: 'user-2', authorName: 'user-2@example.com', text: 'parent text' }],
    })
  })

  test('marks a reply to a bot-authored parent as bot-directed (no structured mention)', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: { getMessage: parentFrom('bot-1') },
    })

    expect(enriched.replyToBotMessageId).toBe('parent')
    expect(enriched.replyToOtherMessageId).toBeNull()
  })

  test('marks a reply to a non-bot parent as directed at another author', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: { getMessage: parentFrom('user-2') },
    })

    expect(enriched.replyToOtherMessageId).toBe('parent')
    expect(enriched.replyToBotMessageId).toBeNull()
  })

  test('classifies an alias-addressed reply to a non-bot parent as directed at the parent author', async () => {
    const aliasAddressedReply = { ...inbound, text: '타이피야 확인해줘', isBotMention: true }
    const enriched = await enrichWebexMessageReference({
      inbound: aliasAddressedReply,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: { getMessage: parentFrom('user-2') },
    })

    expect(enriched.isBotMention).toBe(true)
    expect(enriched.replyToBotMessageId).toBeNull()
    expect(enriched.replyToOtherMessageId).toBe('parent')
  })

  test('attributes a bot-authored parent even when its text is empty', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: { getMessage: parentFrom('bot-1', '') },
    })

    expect(enriched.replyToBotMessageId).toBe('parent')
    expect(enriched.referenceContext).toBeUndefined()
  })

  test('does not clobber a classifier-set reply attribution', async () => {
    const preAttributed = { ...inbound, replyToBotMessageId: 'already' }
    const enriched = await enrichWebexMessageReference({
      inbound: preAttributed,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: { getMessage: parentFrom('user-2') },
    })

    expect(enriched.replyToBotMessageId).toBe('already')
    expect(enriched.replyToOtherMessageId).toBeNull()
  })

  test('swallows parent fetch failures', async () => {
    const enriched = await enrichWebexMessageReference({
      inbound,
      parentRef: 'parent',
      botPersonId: 'bot-1',
      client: {
        getMessage: async () => {
          throw new Error('boom')
        },
      },
    })

    expect(enriched).toEqual(inbound)
  })
})
