import { describe, expect, test } from 'bun:test'

import { channelsSchema, STICKY_DEFAULT_WINDOW_MS } from './schema'

describe('channelsSchema', () => {
  test('parses an empty channels record', () => {
    const parsed = channelsSchema.parse({})
    expect(parsed['discord-bot']).toBeUndefined()
    expect(parsed['slack-bot']).toBeUndefined()
    expect(parsed['telegram-bot']).toBeUndefined()
    expect(parsed.kakaotalk).toBeUndefined()
  })

  test('parses adapter blocks with engagement defaults applied', () => {
    const parsed = channelsSchema.parse({
      'discord-bot': {},
      'slack-bot': {},
      'telegram-bot': {},
      kakaotalk: {},
    })
    for (const id of ['discord-bot', 'slack-bot', 'telegram-bot', 'kakaotalk'] as const) {
      expect(parsed[id]?.enabled).toBe(true)
      expect(parsed[id]?.engagement.trigger).toEqual(['mention', 'reply', 'dm'])
      expect(parsed[id]?.engagement.stickiness).toEqual({
        perReply: { window: STICKY_DEFAULT_WINDOW_MS },
      })
    }
  })

  test('silently strips legacy `allow` field on parse (migration is upstream)', () => {
    const parsed = channelsSchema.parse({
      'slack-bot': { allow: ['team:T0123'] },
    } as unknown as Parameters<typeof channelsSchema.parse>[0])
    expect(parsed['slack-bot']).toBeDefined()
    expect((parsed['slack-bot'] as Record<string, unknown>).allow).toBeUndefined()
  })

  test('accepts engagement.stickiness=off', () => {
    const parsed = channelsSchema.parse({
      'discord-bot': { engagement: { stickiness: 'off' } },
    })
    expect(parsed['discord-bot']?.engagement.stickiness).toBe('off')
  })

  test('clamps engagement.trigger to known triggers', () => {
    expect(() =>
      channelsSchema.parse({ 'discord-bot': { engagement: { trigger: ['username'] } } } as unknown as Parameters<
        typeof channelsSchema.parse
      >[0]),
    ).toThrow()
  })

  test('allows enabled: false', () => {
    const parsed = channelsSchema.parse({ 'discord-bot': { enabled: false } })
    expect(parsed['discord-bot']?.enabled).toBe(false)
  })

  test('accepts github channel config with webhookUrl omitted', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'] } })
    expect(parsed.github?.webhookUrl).toBeUndefined()
    expect(parsed.github?.repos).toEqual(['owner/repo'])
  })

  test('accepts github channel config with webhookUrl present', () => {
    const parsed = channelsSchema.parse({
      github: { webhookUrl: 'https://agent.example.com/github', repos: ['owner/repo'] },
    })
    expect(parsed.github?.webhookUrl).toBe('https://agent.example.com/github')
  })
})
