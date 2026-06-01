import { describe, expect, it } from 'bun:test'

import { removeRequestedReviewer } from './decoy-reviewer'

function fakeFetch(fn: (input: string, init?: RequestInit) => Response): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fn(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init)
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch
}

describe('removeRequestedReviewer', () => {
  function call(fetchImpl: typeof fetch) {
    return removeRequestedReviewer({
      fetchImpl,
      token: 'tok',
      owner: 'acme',
      repo: 'project',
      pullNumber: 7,
      reviewerLogin: 'acme-bot',
    })
  }

  it('issues an authenticated DELETE with the reviewer in the body', async () => {
    let seen: { url: string; method?: string; headers: Headers; body: string } | null = null
    const result = await call(
      fakeFetch((url, init) => {
        seen = { url, method: init?.method, headers: new Headers(init?.headers), body: String(init?.body) }
        return new Response('', { status: 200 })
      }),
    )
    expect(result).toEqual({ kind: 'removed', status: 200 })
    expect(seen!.url).toBe('https://api.github.com/repos/acme/project/pulls/7/requested_reviewers')
    expect(seen!.method).toBe('DELETE')
    expect(seen!.headers.get('Authorization')).toBe('Bearer tok')
    expect(JSON.parse(seen!.body)).toEqual({ reviewers: ['acme-bot'] })
  })

  it('classifies 404 and 422 as absent (benign no-op)', async () => {
    const r404 = await call(fakeFetch(() => new Response('not found', { status: 404 })))
    const r422 = await call(fakeFetch(() => new Response('not requested', { status: 422 })))
    expect(r404.kind).toBe('absent')
    expect(r422.kind).toBe('absent')
  })

  it('classifies auth/server errors as failed', async () => {
    const result = await call(fakeFetch(() => new Response('Resource not accessible by integration', { status: 403 })))
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.reason).toContain('403')
  })

  it('classifies a network throw as failed', async () => {
    const result = await call(
      fakeFetch(() => {
        throw new Error('ECONNRESET')
      }),
    )
    expect(result).toEqual({ kind: 'failed', reason: 'ECONNRESET' })
  })
})
