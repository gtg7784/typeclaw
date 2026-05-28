import { describe, expect, test } from 'bun:test'

import { decodeClaudeAccessTokenExpiryMs, emitClaudeCredentialsJson } from './claude-credentials-json'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('emitClaudeCredentialsJson', () => {
  test('emits the claudeAiOauth shape with trailing newline', () => {
    const out = emitClaudeCredentialsJson({
      type: 'oauth',
      access: makeJwt({ exp: 2_000_000_000 }),
      refresh: 'refresh-1',
      expires: 2_000_000_000_000,
    } as never)

    expect(out.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(out) as { claudeAiOauth: Record<string, unknown> }
    expect(parsed.claudeAiOauth['refreshToken']).toBe('refresh-1')
    expect(parsed.claudeAiOauth['expiresAt']).toBe(2_000_000_000_000)
    expect(typeof parsed.claudeAiOauth['accessToken']).toBe('string')
  })

  test('includes optional scopes when supplied as a string array', () => {
    const out = emitClaudeCredentialsJson({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      scopes: ['user:inference', 'user:profile'],
    } as never)
    const parsed = JSON.parse(out) as { claudeAiOauth: { scopes?: string[] } }
    expect(parsed.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile'])
  })

  test('omits scopes when not a string array', () => {
    const out = emitClaudeCredentialsJson({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      scopes: 'oops-not-an-array',
    } as never)
    const parsed = JSON.parse(out) as { claudeAiOauth: Record<string, unknown> }
    expect(parsed.claudeAiOauth['scopes']).toBeUndefined()
  })

  test('includes subscriptionType when set', () => {
    const out = emitClaudeCredentialsJson({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      subscriptionType: 'max',
    } as never)
    const parsed = JSON.parse(out) as { claudeAiOauth: { subscriptionType?: string } }
    expect(parsed.claudeAiOauth.subscriptionType).toBe('max')
  })

  test('omits subscriptionType when empty or non-string', () => {
    const out = emitClaudeCredentialsJson({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      subscriptionType: '',
    } as never)
    const parsed = JSON.parse(out) as { claudeAiOauth: Record<string, unknown> }
    expect(parsed.claudeAiOauth['subscriptionType']).toBeUndefined()
  })

  test('preserves a caller-supplied mcpOAuth block alongside claudeAiOauth', () => {
    const mcp = { 'server-1': { tokens: { access_token: 'x' } } }
    const out = emitClaudeCredentialsJson({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 } as never, {
      preserveMcpOAuth: mcp,
    })
    const parsed = JSON.parse(out) as { claudeAiOauth: unknown; mcpOAuth: unknown }
    expect(parsed.mcpOAuth).toEqual(mcp)
  })

  test('omits mcpOAuth when not supplied (single-key emit)', () => {
    const out = emitClaudeCredentialsJson({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
    } as never)
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['claudeAiOauth'])
  })

  test('falls back to JWT exp (in ms) when credential lacks `expires`', () => {
    const out = emitClaudeCredentialsJson({
      type: 'oauth',
      access: makeJwt({ exp: 1_900_000_000 }),
      refresh: 'r',
    } as never)
    const parsed = JSON.parse(out) as { claudeAiOauth: { expiresAt: number } }
    expect(parsed.claudeAiOauth.expiresAt).toBe(1_900_000_000_000)
  })

  test('falls back to 0 when credential lacks `expires` AND access is not a decodable JWT', () => {
    const out = emitClaudeCredentialsJson({
      type: 'oauth',
      access: 'not.a.jwt',
      refresh: 'r',
    } as never)
    const parsed = JSON.parse(out) as { claudeAiOauth: { expiresAt: number } }
    expect(parsed.claudeAiOauth.expiresAt).toBe(0)
  })

  test('throws on api-key credentials', () => {
    expect(() => emitClaudeCredentialsJson({ type: 'api_key', key: { value: 'sk-x' } } as never)).toThrow(
      'only accepts oauth-typed',
    )
  })

  test('throws when access is missing or empty', () => {
    expect(() => emitClaudeCredentialsJson({ type: 'oauth', refresh: 'r', expires: 1 } as never)).toThrow('access')
    expect(() => emitClaudeCredentialsJson({ type: 'oauth', access: '', refresh: 'r', expires: 1 } as never)).toThrow(
      'access',
    )
  })

  test('throws when refresh is missing or empty', () => {
    expect(() => emitClaudeCredentialsJson({ type: 'oauth', access: 'a', expires: 1 } as never)).toThrow('refresh')
    expect(() => emitClaudeCredentialsJson({ type: 'oauth', access: 'a', refresh: '', expires: 1 } as never)).toThrow(
      'refresh',
    )
  })
})

describe('decodeClaudeAccessTokenExpiryMs', () => {
  test('decodes a real-shaped JWT and returns ms expiry', () => {
    const exp = 1_900_000_000
    const jwt = makeJwt({ exp, foo: 'bar' })
    expect(decodeClaudeAccessTokenExpiryMs(jwt)).toBe(exp * 1000)
  })

  test('returns null when the token is not three dot-separated parts', () => {
    expect(decodeClaudeAccessTokenExpiryMs('not-a-jwt')).toBeNull()
    expect(decodeClaudeAccessTokenExpiryMs('only.two')).toBeNull()
    expect(decodeClaudeAccessTokenExpiryMs('a.b.c.d')).toBeNull()
  })

  test('returns null when the middle segment is not valid base64 JSON', () => {
    expect(decodeClaudeAccessTokenExpiryMs('a.!!!.c')).toBeNull()
  })

  test('returns null when exp is missing', () => {
    const jwt = makeJwt({ sub: 'x' })
    expect(decodeClaudeAccessTokenExpiryMs(jwt)).toBeNull()
  })

  test('returns null when exp is not a finite number', () => {
    const stringExp = makeJwt({ exp: '1700000000' })
    expect(decodeClaudeAccessTokenExpiryMs(stringExp)).toBeNull()
    const infinityExp = makeJwt({ exp: Number.POSITIVE_INFINITY })
    expect(decodeClaudeAccessTokenExpiryMs(infinityExp)).toBeNull()
  })
})
