import { describe, expect, test } from 'bun:test'

import { channelsSchema, isAllowed, STICKY_DEFAULT_WINDOW_MS } from './schema'

describe('channelsSchema', () => {
  test('parses an empty channels record', () => {
    const parsed = channelsSchema.parse({})
    expect(parsed['discord-bot']).toBeUndefined()
  })

  test('applies engagement and enabled defaults when omitted', () => {
    const parsed = channelsSchema.parse({ 'discord-bot': { allow: ['*'] } })
    expect(parsed['discord-bot']?.allow).toEqual(['*'])
    expect(parsed['discord-bot']?.enabled).toBe(true)
    expect(parsed['discord-bot']?.engagement.trigger).toEqual(['mention', 'reply', 'dm'])
    expect(parsed['discord-bot']?.engagement.stickiness).toEqual({
      perReply: { window: STICKY_DEFAULT_WINDOW_MS },
    })
  })

  test('rejects malformed allow rules', () => {
    expect(() => channelsSchema.parse({ 'discord-bot': { allow: ['nope'] } })).toThrow()
    expect(() => channelsSchema.parse({ 'discord-bot': { allow: ['guild:abc'] } })).toThrow()
    expect(() => channelsSchema.parse({ 'discord-bot': { allow: ['dm:'] } })).toThrow()
    expect(() => channelsSchema.parse({ 'discord-bot': { allow: [''] } })).toThrow()
  })

  test('accepts every documented allow rule shape', () => {
    const parsed = channelsSchema.parse({
      'discord-bot': {
        allow: ['*', 'guild:*', 'guild:1', 'guild:1/2', 'channel:3', 'dm:*', 'dm:4'],
      },
    })
    expect(parsed['discord-bot']?.allow).toHaveLength(7)
  })

  test('accepts engagement.stickiness=off', () => {
    const parsed = channelsSchema.parse({
      'discord-bot': { allow: [], engagement: { stickiness: 'off' } },
    })
    expect(parsed['discord-bot']?.engagement.stickiness).toBe('off')
  })

  test('clamps engagement.trigger to known triggers', () => {
    expect(() =>
      channelsSchema.parse({ 'discord-bot': { allow: [], engagement: { trigger: ['username'] } } }),
    ).toThrow()
  })
})

describe('isAllowed', () => {
  test('"*" matches every guild channel and every DM', () => {
    expect(isAllowed(['*'], 'g1', 'c1')).toBe(true)
    expect(isAllowed(['*'], '@dm', 'd1')).toBe(true)
  })

  test('"guild:*" matches any guild channel but no DMs', () => {
    expect(isAllowed(['guild:*'], 'g1', 'c1')).toBe(true)
    expect(isAllowed(['guild:*'], 'g2', 'c2')).toBe(true)
    expect(isAllowed(['guild:*'], '@dm', 'd1')).toBe(false)
  })

  test('"guild:G" scopes to that guild', () => {
    expect(isAllowed(['guild:1'], '1', 'anything')).toBe(true)
    expect(isAllowed(['guild:1'], '2', 'anything')).toBe(false)
  })

  test('"guild:G/C" requires both guild and channel match', () => {
    expect(isAllowed(['guild:1/2'], '1', '2')).toBe(true)
    expect(isAllowed(['guild:1/2'], '1', '3')).toBe(false)
    expect(isAllowed(['guild:1/2'], '2', '2')).toBe(false)
  })

  test('"channel:C" matches that channel id in any guild', () => {
    expect(isAllowed(['channel:42'], 'g1', '42')).toBe(true)
    expect(isAllowed(['channel:42'], 'g2', '42')).toBe(true)
    expect(isAllowed(['channel:42'], 'g1', '99')).toBe(false)
  })

  test('"channel:C" also matches a DM channel by id', () => {
    expect(isAllowed(['channel:42'], '@dm', '42')).toBe(true)
  })

  test('"dm:*" matches every DM but no guild channels', () => {
    expect(isAllowed(['dm:*'], '@dm', 'd1')).toBe(true)
    expect(isAllowed(['dm:*'], 'g1', 'c1')).toBe(false)
  })

  test('"dm:C" matches that DM channel only', () => {
    expect(isAllowed(['dm:7'], '@dm', '7')).toBe(true)
    expect(isAllowed(['dm:7'], '@dm', '8')).toBe(false)
    expect(isAllowed(['dm:7'], 'g1', '7')).toBe(false)
  })

  test('any single matching rule admits', () => {
    expect(isAllowed(['guild:1', 'dm:*'], 'g1', 'c1')).toBe(false)
    expect(isAllowed(['guild:1', 'dm:*'], '1', 'c1')).toBe(true)
    expect(isAllowed(['guild:1', 'dm:*'], '@dm', 'd1')).toBe(true)
  })

  test('empty rules list admits nothing', () => {
    expect(isAllowed([], 'g1', 'c1')).toBe(false)
    expect(isAllowed([], '@dm', 'd1')).toBe(false)
  })
})
