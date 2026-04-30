import { describe, expect, test } from 'bun:test'

import { channelsSchema, isAllowed, STICKY_DEFAULT_WINDOW_MS } from './schema'

describe('channelsSchema', () => {
  test('parses an empty channels record', () => {
    const parsed = channelsSchema.parse({})
    expect(parsed['discord-bot']).toBeUndefined()
    expect(parsed['slack-bot']).toBeUndefined()
  })

  test('parses a slack-bot config alongside discord-bot', () => {
    const parsed = channelsSchema.parse({
      'discord-bot': { allow: ['guild:1/2'] },
      'slack-bot': { allow: ['team:T0ACME/C0DEPLOY'] },
    })
    expect(parsed['discord-bot']?.allow).toEqual(['guild:1/2'])
    expect(parsed['slack-bot']?.allow).toEqual(['team:T0ACME/C0DEPLOY'])
    expect(parsed['slack-bot']?.enabled).toBe(true)
    expect(parsed['slack-bot']?.engagement.trigger).toEqual(['mention', 'reply', 'dm'])
  })

  test('rejects malformed slack allow rules', () => {
    expect(() => channelsSchema.parse({ 'slack-bot': { allow: ['team:'] } })).toThrow()
    expect(() => channelsSchema.parse({ 'slack-bot': { allow: ['im:'] } })).toThrow()
    expect(() => channelsSchema.parse({ 'slack-bot': { allow: ['team:lowercase'] } })).toThrow()
  })

  test('accepts every documented slack allow rule shape', () => {
    const parsed = channelsSchema.parse({
      'slack-bot': {
        allow: ['*', 'team:*', 'team:T0ACME', 'team:T0ACME/C0DEPLOY', 'channel:C0DEPLOY', 'im:*', 'im:D0DM'],
      },
    })
    expect(parsed['slack-bot']?.allow).toHaveLength(7)
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

  test('"team:*" matches any Slack team channel but no DMs', () => {
    expect(isAllowed(['team:*'], 'T0ACME', 'C0CHANNEL')).toBe(true)
    expect(isAllowed(['team:*'], 'T0WIDGET', 'C0CHANNEL')).toBe(true)
    expect(isAllowed(['team:*'], '@dm', 'D0DMID')).toBe(false)
  })

  test('"team:T" scopes to that team', () => {
    expect(isAllowed(['team:T0ACME'], 'T0ACME', 'C0ANY')).toBe(true)
    expect(isAllowed(['team:T0ACME'], 'T0WIDGET', 'C0ANY')).toBe(false)
  })

  test('"team:T/C" requires both team and channel match', () => {
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0ACME', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0ACME', 'C0OTHER')).toBe(false)
    expect(isAllowed(['team:T0ACME/C0DEPLOY'], 'T0WIDGET', 'C0DEPLOY')).toBe(false)
  })

  test('"im:*" matches every Slack DM but no team channels', () => {
    expect(isAllowed(['im:*'], '@dm', 'D0DMID')).toBe(true)
    expect(isAllowed(['im:*'], 'T0ACME', 'C0CHANNEL')).toBe(false)
  })

  test('"im:D" matches that Slack DM channel only', () => {
    expect(isAllowed(['im:D0DMID'], '@dm', 'D0DMID')).toBe(true)
    expect(isAllowed(['im:D0DMID'], '@dm', 'D0OTHER')).toBe(false)
  })

  test('"channel:C" matches a Slack channel id in any team', () => {
    expect(isAllowed(['channel:C0DEPLOY'], 'T0ACME', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['channel:C0DEPLOY'], 'T0WIDGET', 'C0DEPLOY')).toBe(true)
    expect(isAllowed(['channel:C0DEPLOY'], 'T0ACME', 'C0OTHER')).toBe(false)
  })
})
