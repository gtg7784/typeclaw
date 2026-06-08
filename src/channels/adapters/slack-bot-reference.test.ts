import { describe, expect, test } from 'bun:test'

import {
  enrichSlackReferenceContext,
  hasSlackMessageShareAttachments,
  type SlackReferenceFetch,
} from './slack-bot-reference'

type FetchCall = { channelId: string; messageTs: string }

function fakeFetch(messages: ReadonlyMap<string, { authorId: string; authorName: string; text: string } | null>): {
  fetch: SlackReferenceFetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  return {
    calls,
    fetch: async (channelId, messageTs) => {
      calls.push({ channelId, messageTs })
      return messages.get(`${channelId}:${messageTs}`) ?? null
    },
  }
}

describe('enrichSlackReferenceContext', () => {
  test('does not derive reply context from thread membership', async () => {
    // Slack thread_ts is the thread root on EVERY in-thread message, so it is
    // not a per-message reply signal. A plain in-thread reply must not fetch
    // or attach the root as quote context.
    const { fetch, calls } = fakeFetch(
      new Map([['C1:1700.000001', { authorId: 'UBOB', authorName: 'Bob', text: 'root text' }]]),
    )

    const result = await enrichSlackReferenceContext({
      text: 'actual reply',
      channelId: 'C1',
      messageTs: '1700.000002',
      fetchMessage: fetch,
    })

    expect(result).toEqual({ text: 'actual reply' })
    expect(calls).toEqual([])
  })

  test('keeps share-only raw text empty and adds quote context from share attachments', async () => {
    const result = await enrichSlackReferenceContext({
      text: '',
      channelId: 'C1',
      messageTs: '1700.000002',
      attachments: [{ author_id: 'UBOB', author_name: 'Bob', text: 'shared text' }],
      fetchMessage: async () => null,
    })

    expect(result).toEqual({
      text: '',
      referenceContext: {
        kind: 'quote',
        sources: [{ adapter: 'slack-bot', authorId: 'UBOB', authorName: 'Bob', text: 'shared text' }],
      },
    })
  })

  test('resolves Slack permalinks with dedupe and cap', async () => {
    const { fetch, calls } = fakeFetch(
      new Map([
        ['C1:1700000000.000001', { authorId: 'U1', authorName: 'Alice', text: 'one' }],
        ['C2:1700000000.000002', { authorId: 'U2', authorName: 'Bob', text: 'two' }],
      ]),
    )

    const result = await enrichSlackReferenceContext({
      text: 'see https://acme.slack.com/archives/C1/p1700000000000001 https://acme.slack.com/archives/C1/p1700000000000001 https://acme.slack.com/archives/C2/p1700000000000002 https://acme.slack.com/archives/C3/p1700000000000003',
      channelId: 'C0',
      messageTs: '1700.000003',
      fetchMessage: fetch,
      linkLimit: 2,
    })

    expect(calls).toEqual([
      { channelId: 'C1', messageTs: '1700000000.000001' },
      { channelId: 'C2', messageTs: '1700000000.000002' },
    ])
    expect(result.referenceContext?.sources).toEqual([
      { adapter: 'slack-bot', authorId: 'U1', authorName: 'Alice', text: 'one' },
      { adapter: 'slack-bot', authorId: 'U2', authorName: 'Bob', text: 'two' },
    ])
  })

  test('omits failed references and reports no context when nothing resolves', async () => {
    const result = await enrichSlackReferenceContext({
      text: 'see https://acme.slack.com/archives/C1/p1700000000000001',
      channelId: 'C0',
      messageTs: '1700.000003',
      fetchMessage: async () => {
        throw new Error('missing access')
      },
    })

    expect(result).toEqual({ text: 'see https://acme.slack.com/archives/C1/p1700000000000001' })
  })
})

describe('hasSlackMessageShareAttachments', () => {
  test('detects attachments with share text and an author id', () => {
    expect(hasSlackMessageShareAttachments([{ author_id: 'UBOB', text: 'shared text' }])).toBe(true)
    expect(hasSlackMessageShareAttachments([{ text: 'missing author' }])).toBe(false)
  })

  test('falls back to author_subname for the source name but still requires an author id', async () => {
    const withSubname = await enrichSlackReferenceContext({
      text: '',
      channelId: 'C1',
      messageTs: '1700.000002',
      attachments: [{ user_id: 'UEVE', author_subname: 'Eve', text: 'forwarded note' }],
      fetchMessage: async () => null,
    })
    expect(withSubname.referenceContext?.sources).toEqual([
      { adapter: 'slack-bot', authorId: 'UEVE', authorName: 'Eve', text: 'forwarded note' },
    ])

    const idless = await enrichSlackReferenceContext({
      text: '',
      channelId: 'C1',
      messageTs: '1700.000002',
      attachments: [{ author_subname: 'Eve', text: 'forwarded note' }],
      fetchMessage: async () => null,
    })
    expect(idless).toEqual({ text: '' })
  })
})
