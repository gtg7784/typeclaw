import { describe, expect, test } from 'bun:test'

import { decodeCodexAccessTokenExpiryMs, emitCodexAuthJson } from './codex-auth-json'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('emitCodexAuthJson', () => {
  test('emits the modern tokens-only shape with trailing newline', () => {
    const out = emitCodexAuthJson({
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 123,
    } as never)

    expect(out.endsWith('\n')).toBe(true)
    expect(JSON.parse(out)).toEqual({
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1' },
    })
  })

  test('includes account_id when accountId is set on the credential', () => {
    const out = emitCodexAuthJson({
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 123,
      accountId: 'acct-abc',
    } as never)

    expect(JSON.parse(out)).toEqual({
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1', account_id: 'acct-abc' },
    })
  })

  test('omits account_id when accountId is missing or empty', () => {
    const out = emitCodexAuthJson({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      accountId: '',
    } as never)
    const parsed = JSON.parse(out) as { tokens: Record<string, unknown> }
    expect(parsed.tokens.account_id).toBeUndefined()
  })

  test('omits top-level expires (codex re-derives from JWT)', () => {
    const out = emitCodexAuthJson({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 999999999,
    } as never)
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed['expires']).toBeUndefined()
  })

  test('throws on api-key credentials', () => {
    expect(() => emitCodexAuthJson({ type: 'api_key', key: { value: 'sk-x' } } as never)).toThrow(
      'only accepts oauth-typed',
    )
  })

  test('throws when access is missing or empty', () => {
    expect(() => emitCodexAuthJson({ type: 'oauth', refresh: 'r', expires: 1 } as never)).toThrow('access')
    expect(() => emitCodexAuthJson({ type: 'oauth', access: '', refresh: 'r', expires: 1 } as never)).toThrow('access')
  })

  test('throws when refresh is missing or empty', () => {
    expect(() => emitCodexAuthJson({ type: 'oauth', access: 'a', expires: 1 } as never)).toThrow('refresh')
    expect(() => emitCodexAuthJson({ type: 'oauth', access: 'a', refresh: '', expires: 1 } as never)).toThrow('refresh')
  })
})

describe('decodeCodexAccessTokenExpiryMs', () => {
  test('decodes a real-shaped JWT and returns ms expiry', () => {
    const exp = 1_900_000_000
    const jwt = makeJwt({ exp, foo: 'bar' })
    expect(decodeCodexAccessTokenExpiryMs(jwt)).toBe(exp * 1000)
  })

  test('returns null when the token is not three dot-separated parts', () => {
    expect(decodeCodexAccessTokenExpiryMs('not-a-jwt')).toBeNull()
    expect(decodeCodexAccessTokenExpiryMs('only.two')).toBeNull()
    expect(decodeCodexAccessTokenExpiryMs('a.b.c.d')).toBeNull()
  })

  test('returns null when the middle segment is not valid base64 JSON', () => {
    expect(decodeCodexAccessTokenExpiryMs('a.!!!.c')).toBeNull()
  })

  test('returns null when exp is missing', () => {
    const jwt = makeJwt({ sub: 'x' })
    expect(decodeCodexAccessTokenExpiryMs(jwt)).toBeNull()
  })

  test('returns null when exp is not a finite number', () => {
    const stringExp = makeJwt({ exp: '1700000000' })
    expect(decodeCodexAccessTokenExpiryMs(stringExp)).toBeNull()
    const infinityExp = makeJwt({ exp: Number.POSITIVE_INFINITY })
    expect(decodeCodexAccessTokenExpiryMs(infinityExp)).toBeNull()
  })
})
