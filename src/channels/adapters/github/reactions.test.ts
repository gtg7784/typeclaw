import { describe, expect, it } from 'bun:test'

import {
  createGithubReactionCallback,
  decodeGithubReactionRef,
  encodeGithubReactionRef,
  type GithubReactionTarget,
} from './reactions'

const fakeFetch = (responses: Record<string, { status: number; body?: unknown }>, seen?: { calls: string[] }) =>
  Object.assign(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const key = `${init?.method ?? 'GET'} ${String(url)}`
      seen?.calls.push(key)
      const resp = responses[key] ?? { status: 404, body: { message: 'Not Found' } }
      return new Response(JSON.stringify(resp.body ?? {}), { status: resp.status })
    },
    { preconnect: () => {} },
  )

const cbFor = (responses: Record<string, { status: number; body?: unknown }>, seen?: { calls: string[] }) =>
  createGithubReactionCallback({ token: async () => 'tok', authType: 'app', fetchImpl: fakeFetch(responses, seen) })

const req = (target: GithubReactionTarget, emoji = 'eyes') => ({
  adapter: 'github' as const,
  workspace: `${target.owner}/${target.repo}`,
  chat: target.kind === 'issue' ? `issue:${target.issueNumber}` : 'pr:1',
  thread: null,
  reactionRef: encodeGithubReactionRef(target),
  emoji,
})

describe('encode/decode reaction ref', () => {
  it('round-trips each target kind', () => {
    const targets: GithubReactionTarget[] = [
      { kind: 'issue', owner: 'acme', repo: 'p', issueNumber: 7 },
      { kind: 'issue-comment', owner: 'acme', repo: 'p', commentId: 11 },
      { kind: 'pr-review-comment', owner: 'acme', repo: 'p', commentId: 22 },
    ]
    for (const t of targets) expect(decodeGithubReactionRef(encodeGithubReactionRef(t))).toEqual(t)
  })

  it('rejects a ref from another adapter', () => {
    expect(decodeGithubReactionRef({ adapter: 'slack-bot', value: '{}' })).toBeNull()
  })

  it('rejects malformed json', () => {
    expect(decodeGithubReactionRef({ adapter: 'github', value: 'not json' })).toBeNull()
  })
})

describe('createGithubReactionCallback endpoint selection', () => {
  it('reacts to an issue/PR body via the issues reactions endpoint', async () => {
    const seen = { calls: [] as string[] }
    const cb = cbFor({ 'POST https://api.github.com/repos/acme/p/issues/7/reactions': { status: 201 } }, seen)
    const result = await cb(req({ kind: 'issue', owner: 'acme', repo: 'p', issueNumber: 7 }))
    expect(result).toEqual({ ok: true })
    expect(seen.calls).toEqual(['POST https://api.github.com/repos/acme/p/issues/7/reactions'])
  })

  it('reacts to an issue comment via the issues comments reactions endpoint', async () => {
    const seen = { calls: [] as string[] }
    const cb = cbFor({ 'POST https://api.github.com/repos/acme/p/issues/comments/11/reactions': { status: 201 } }, seen)
    const result = await cb(req({ kind: 'issue-comment', owner: 'acme', repo: 'p', commentId: 11 }))
    expect(result).toEqual({ ok: true })
    expect(seen.calls).toEqual(['POST https://api.github.com/repos/acme/p/issues/comments/11/reactions'])
  })

  it('reacts to a PR review comment via the pulls comments reactions endpoint', async () => {
    const seen = { calls: [] as string[] }
    const cb = cbFor({ 'POST https://api.github.com/repos/acme/p/pulls/comments/22/reactions': { status: 201 } }, seen)
    const result = await cb(req({ kind: 'pr-review-comment', owner: 'acme', repo: 'p', commentId: 22 }))
    expect(result).toEqual({ ok: true })
    expect(seen.calls).toEqual(['POST https://api.github.com/repos/acme/p/pulls/comments/22/reactions'])
  })
})

describe('createGithubReactionCallback behavior', () => {
  it('treats HTTP 200 (already reacted) as success', async () => {
    const cb = cbFor({ 'POST https://api.github.com/repos/acme/p/issues/7/reactions': { status: 200 } })
    const result = await cb(req({ kind: 'issue', owner: 'acme', repo: 'p', issueNumber: 7 }))
    expect(result).toEqual({ ok: true })
  })

  it('rejects an unsupported emoji as unsupported', async () => {
    const cb = cbFor({})
    const result = await cb(req({ kind: 'issue', owner: 'acme', repo: 'p', issueNumber: 7 }, 'pizza'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unsupported')
  })

  it('decorates a 403 integration permission denial with guidance', async () => {
    const cb = cbFor({
      'POST https://api.github.com/repos/acme/p/issues/7/reactions': {
        status: 403,
        body: { message: 'Resource not accessible by integration' },
      },
    })
    const result = await cb(req({ kind: 'issue', owner: 'acme', repo: 'p', issueNumber: 7 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('permission-denied')
      expect(result.error).toContain('Issues')
    }
  })
})
