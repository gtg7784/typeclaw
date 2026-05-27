import { describe, expect, test } from 'bun:test'

import { DISCORD_BOT_INVITE_PERMISSIONS, buildDiscordInviteUrl, deriveAppIdFromBotToken } from './discord-bot-invite'

function encodeSnowflakeSegment(snowflake: string): string {
  return Buffer.from(snowflake, 'utf-8').toString('base64').replace(/=+$/, '')
}

describe('deriveAppIdFromBotToken', () => {
  test('extracts snowflake id from the first base64 segment', () => {
    const head = encodeSnowflakeSegment('968556348390391859')
    const token = `${head}.G49NjP.pD8PLpKp-Xx8sr-8m1DCxSPTJZdcpcJZOExc1c`
    expect(deriveAppIdFromBotToken(token)).toBe('968556348390391859')
  })

  test('handles missing base64 padding (real Discord tokens omit it)', () => {
    const head = encodeSnowflakeSegment('123456789012345678')
    expect(head.endsWith('=')).toBe(false)
    const token = `${head}.middle.signature`
    expect(deriveAppIdFromBotToken(token)).toBe('123456789012345678')
  })

  test('returns null when the token is not three dot-separated segments', () => {
    expect(deriveAppIdFromBotToken('only.two')).toBeNull()
    expect(deriveAppIdFromBotToken('a.b.c.d')).toBeNull()
    expect(deriveAppIdFromBotToken('')).toBeNull()
  })

  test('returns null when the first segment decodes to a non-snowflake', () => {
    const garbage = `${Buffer.from('hello-world', 'utf-8').toString('base64').replace(/=+$/, '')}.middle.sig`
    expect(deriveAppIdFromBotToken(garbage)).toBeNull()
  })

  test('returns null when the decoded id is too short to be a snowflake', () => {
    const tooShort = `${encodeSnowflakeSegment('12345')}.middle.sig`
    expect(deriveAppIdFromBotToken(tooShort)).toBeNull()
  })

  test('returns null when the first segment is empty', () => {
    expect(deriveAppIdFromBotToken('.middle.sig')).toBeNull()
  })
})

describe('buildDiscordInviteUrl', () => {
  test('builds the canonical OAuth2 authorize URL with adapter defaults', () => {
    const url = buildDiscordInviteUrl('968556348390391859')
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(parsed.searchParams.get('client_id')).toBe('968556348390391859')
    expect(parsed.searchParams.get('scope')).toBe('bot applications.commands')
    expect(parsed.searchParams.get('permissions')).toBe(DISCORD_BOT_INVITE_PERMISSIONS.toString())
  })

  test('preserves bigint permissions beyond 2^32 without precision loss', () => {
    expect(DISCORD_BOT_INVITE_PERMISSIONS).toBeGreaterThan(2n ** 32n)
    const url = buildDiscordInviteUrl('1', { permissions: 1n << 38n })
    expect(new URL(url).searchParams.get('permissions')).toBe('274877906944')
  })

  test('allows callers to override permissions and scopes', () => {
    const url = buildDiscordInviteUrl('111', { permissions: 8n, scopes: ['bot'] })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('permissions')).toBe('8')
    expect(parsed.searchParams.get('scope')).toBe('bot')
  })
})

describe('DISCORD_BOT_INVITE_PERMISSIONS', () => {
  test('covers every permission the discord-bot adapter exercises at runtime', () => {
    const required = {
      ADD_REACTIONS: 1n << 6n,
      VIEW_CHANNEL: 1n << 10n,
      SEND_MESSAGES: 1n << 11n,
      EMBED_LINKS: 1n << 14n,
      ATTACH_FILES: 1n << 15n,
      READ_MESSAGE_HISTORY: 1n << 16n,
      USE_APPLICATION_COMMANDS: 1n << 31n,
      SEND_MESSAGES_IN_THREADS: 1n << 38n,
    }
    for (const [name, bit] of Object.entries(required)) {
      expect(`${name}:${(DISCORD_BOT_INVITE_PERMISSIONS & bit) === bit}`).toBe(`${name}:true`)
    }
  })
})
