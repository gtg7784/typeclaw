import { describe, expect, it } from 'bun:test'

import { PatAuthStrategy } from './auth-pat'

describe('PatAuthStrategy', () => {
  it('authenticates a PAT against /user', async () => {
    let auth = ''
    const strategy = new PatAuthStrategy({
      token: { value: 'github_pat_test' },
      fetchImpl: withPreconnect(async (_url, init) => {
        auth = new Headers(init?.headers).get('authorization') ?? ''
        return Response.json({ login: 'typeclaw-bot', id: 123 })
      }),
    })

    const self = await strategy.getSelf()

    expect(self).toEqual({ login: 'typeclaw-bot', id: 123 })
    expect(auth).toBe('Bearer github_pat_test')
  })

  it('rejects a missing PAT', () => {
    expect(() => new PatAuthStrategy({ token: {} })).toThrow(/missing/i)
  })
})

function withPreconnect(fn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(fn, { preconnect: () => {} })
}
