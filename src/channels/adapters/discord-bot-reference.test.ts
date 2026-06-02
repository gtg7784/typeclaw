import { describe, expect, test } from 'bun:test'

import { enrichDiscordMessageReferences, type DiscordReferenceFetch } from './discord-bot-reference'

type FetchCall = { channelId: string; messageId: string }

function fakeFetch(messages: ReadonlyMap<string, { authorName: string; text: string } | null>): {
  fetch: DiscordReferenceFetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  return {
    calls,
    fetch: async (channelId, messageId) => {
      calls.push({ channelId, messageId })
      return messages.get(`${channelId}:${messageId}`) ?? null
    },
  }
}

describe('enrichDiscordMessageReferences', () => {
  test('prepends the parent message content for Discord replies', async () => {
    const { fetch, calls } = fakeFetch(
      new Map([['111111111111111111:222222222222222222', { authorName: 'Alice', text: 'parent text' }]]),
    )

    const text = await enrichDiscordMessageReferences({
      text: 'actual reply',
      reply: { channelId: '111111111111111111', messageId: '222222222222222222' },
      fetchMessage: fetch,
    })

    expect(text).toBe('> ↩ Reply to Alice: parent text\nactual reply')
    expect(calls).toEqual([{ channelId: '111111111111111111', messageId: '222222222222222222' }])
  })

  test('leaves reply text unchanged when the parent fetch fails', async () => {
    const calls: FetchCall[] = []
    const fetch: DiscordReferenceFetch = async (channelId, messageId) => {
      calls.push({ channelId, messageId })
      throw new Error('missing access')
    }

    const text = await enrichDiscordMessageReferences({
      text: 'actual reply',
      reply: { channelId: '111111111111111111', messageId: '222222222222222222' },
      fetchMessage: fetch,
    })

    expect(text).toBe('actual reply')
    expect(calls).toEqual([{ channelId: '111111111111111111', messageId: '222222222222222222' }])
  })

  test('appends resolved content for a standard guild message link', async () => {
    const { fetch } = fakeFetch(
      new Map([['222222222222222222:333333333333333333', { authorName: 'Bob', text: 'linked text' }]]),
    )

    const text = await enrichDiscordMessageReferences({
      text: 'see https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333',
      fetchMessage: fetch,
    })

    expect(text).toBe(
      'see https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333\n\n> 🔗 Discord message from Bob: linked text',
    )
  })

  test('accepts discordapp.com, canary.discord.com, and ptb.discord.com message links', async () => {
    const { fetch, calls } = fakeFetch(
      new Map([
        ['222222222222222222:333333333333333333', { authorName: 'Alice', text: 'one' }],
        ['444444444444444444:555555555555555555', { authorName: 'Bob', text: 'two' }],
        ['666666666666666666:777777777777777777', { authorName: 'Carol', text: 'three' }],
      ]),
    )

    const text = await enrichDiscordMessageReferences({
      text: 'links https://discordapp.com/channels/111111111111111111/222222222222222222/333333333333333333 https://canary.discord.com/channels/@me/444444444444444444/555555555555555555 https://ptb.discord.com/channels/111111111111111111/666666666666666666/777777777777777777',
      fetchMessage: fetch,
    })

    expect(calls).toEqual([
      { channelId: '222222222222222222', messageId: '333333333333333333' },
      { channelId: '444444444444444444', messageId: '555555555555555555' },
      { channelId: '666666666666666666', messageId: '777777777777777777' },
    ])
    expect(text).toContain('> 🔗 Discord message from Alice: one')
    expect(text).toContain('> 🔗 Discord message from Bob: two')
    expect(text).toContain('> 🔗 Discord message from Carol: three')
  })

  test('deduplicates links and caps resolved message links per inbound', async () => {
    const { fetch, calls } = fakeFetch(
      new Map([
        ['222222222222222222:333333333333333333', { authorName: 'Alice', text: 'one' }],
        ['444444444444444444:555555555555555555', { authorName: 'Bob', text: 'two' }],
      ]),
    )

    const text = await enrichDiscordMessageReferences({
      text: 'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333 https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333 https://discord.com/channels/111111111111111111/444444444444444444/555555555555555555 https://discord.com/channels/111111111111111111/666666666666666666/777777777777777777',
      fetchMessage: fetch,
      linkLimit: 2,
    })

    expect(calls).toEqual([
      { channelId: '222222222222222222', messageId: '333333333333333333' },
      { channelId: '444444444444444444', messageId: '555555555555555555' },
    ])
    expect(text).toContain('Alice: one')
    expect(text).toContain('Bob: two')
    expect(text).not.toContain('777777777777777777:')
  })

  test('leaves non-message URLs untouched and does not fetch', async () => {
    const { fetch, calls } = fakeFetch(new Map())

    const text = await enrichDiscordMessageReferences({
      text: 'not a message https://discord.com/developers/docs/resources/channel',
      fetchMessage: fetch,
    })

    expect(text).toBe('not a message https://discord.com/developers/docs/resources/channel')
    expect(calls).toEqual([])
  })

  test('leaves message-link text unchanged when fetch returns null', async () => {
    const { fetch } = fakeFetch(new Map([['222222222222222222:333333333333333333', null]]))

    const text = await enrichDiscordMessageReferences({
      text: 'see https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333',
      fetchMessage: fetch,
    })

    expect(text).toBe('see https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333')
  })

  test('truncates resolved quote and link text', async () => {
    const longText = `${'x'.repeat(280)}tail`
    const { fetch } = fakeFetch(
      new Map([
        ['111111111111111111:222222222222222222', { authorName: 'Alice', text: longText }],
        ['333333333333333333:444444444444444444', { authorName: 'Bob', text: longText }],
      ]),
    )

    const text = await enrichDiscordMessageReferences({
      text: 'see https://discord.com/channels/111111111111111111/333333333333333333/444444444444444444',
      reply: { channelId: '111111111111111111', messageId: '222222222222222222' },
      fetchMessage: fetch,
    })

    expect(text).toContain(`> ↩ Reply to Alice: ${'x'.repeat(280)}…`)
    expect(text).toContain(`> 🔗 Discord message from Bob: ${'x'.repeat(280)}…`)
    expect(text).not.toContain('tail')
  })
})
