import { describe, expect, test } from 'bun:test'

import { createGithubEffectiveApprovalResolver, createGithubHeadShaResolver } from './effective-approval'

const WS = 'acme/widgets'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fetchStub(routes: Record<string, Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const [needle, response] of Object.entries(routes)) {
      if (url.includes(needle)) return response.clone()
    }
    return new Response('not stubbed', { status: 500 })
  }) as typeof fetch
}

describe('github effective-approval resolver', () => {
  test('reports APPROVED when the bot has an APPROVED review on the PR', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': jsonResponse({ login: 'review-bot', id: 1 }),
        '/pulls/5/reviews': jsonResponse([
          { state: 'COMMENTED', user: { login: 'someone', type: 'User' } },
          { state: 'APPROVED', user: { login: 'review-bot', type: 'User' } },
        ]),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 5 })).toEqual({ ok: true, effective: 'APPROVED' })
  })

  test('reports NONE when only OTHER users approved', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': jsonResponse({ login: 'review-bot', id: 1 }),
        '/pulls/6/reviews': jsonResponse([{ state: 'APPROVED', user: { login: 'someone-else', type: 'User' } }]),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 6 })).toEqual({ ok: true, effective: 'NONE' })
  })

  test('reports NONE when the bot only commented', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': jsonResponse({ login: 'review-bot', id: 1 }),
        '/pulls/7/reviews': jsonResponse([{ state: 'COMMENTED', user: { login: 'review-bot', type: 'User' } }]),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 7 })).toEqual({ ok: true, effective: 'NONE' })
  })

  test('reports CHANGES_REQUESTED when a later bot CHANGES_REQUESTED supersedes an earlier APPROVED', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': jsonResponse({ login: 'review-bot', id: 1 }),
        '/pulls/30/reviews': jsonResponse([
          { state: 'APPROVED', user: { login: 'review-bot', type: 'User' } },
          { state: 'CHANGES_REQUESTED', user: { login: 'review-bot', type: 'User' } },
        ]),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 30 })).toEqual({ ok: true, effective: 'CHANGES_REQUESTED' })
  })

  test('reports APPROVED when a later bot APPROVED supersedes an earlier CHANGES_REQUESTED', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': jsonResponse({ login: 'review-bot', id: 1 }),
        '/pulls/31/reviews': jsonResponse([
          { state: 'CHANGES_REQUESTED', user: { login: 'review-bot', type: 'User' } },
          { state: 'APPROVED', user: { login: 'review-bot', type: 'User' } },
        ]),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 31 })).toEqual({ ok: true, effective: 'APPROVED' })
  })

  test('a later bot COMMENTED does not clear an earlier bot APPROVED', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': jsonResponse({ login: 'review-bot', id: 1 }),
        '/pulls/32/reviews': jsonResponse([
          { state: 'APPROVED', user: { login: 'review-bot', type: 'User' } },
          { state: 'COMMENTED', user: { login: 'review-bot', type: 'User' } },
        ]),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 32 })).toEqual({ ok: true, effective: 'APPROVED' })
  })

  test('matches a GitHub App bot whose reviews login carries the [bot] suffix', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': jsonResponse({ login: 'review-bot', id: 1 }),
        '/pulls/8/reviews': jsonResponse([{ state: 'APPROVED', user: { login: 'review-bot[bot]', type: 'Bot' } }]),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 8 })).toEqual({ ok: true, effective: 'APPROVED' })
  })

  test('uses adapter-resolved App identity without calling the unsupported /user endpoint', async () => {
    const seen: string[] = []
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'ghs_installation',
      selfLogin: () => 'review-bot[bot]',
      isAppAuth: () => true,
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        seen.push(url)
        return jsonResponse([{ state: 'CHANGES_REQUESTED', user: { login: 'review-bot[bot]', type: 'Bot' } }])
      },
    })

    expect(await resolve({ workspace: WS, prNumber: 8 })).toEqual({ ok: true, effective: 'CHANGES_REQUESTED' })
    expect(seen.some((url) => url.endsWith('/user'))).toBe(false)
  })

  test('fails open under App auth when adapter identity is unavailable without claiming remote dedupe', async () => {
    let fetched = false
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'ghs_installation',
      selfLogin: () => null,
      isAppAuth: () => true,
      fetchImpl: async () => {
        fetched = true
        return jsonResponse({ login: 'unexpected' })
      },
    })

    expect(await resolve({ workspace: WS, prNumber: 8 })).toEqual({ ok: false })
    expect(fetched).toBe(false)
  })

  test('fails (ok:false) when the reviews fetch errors so the guard can fail open', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': jsonResponse({ login: 'review-bot', id: 1 }),
        '/pulls/9/reviews': new Response('boom', { status: 500 }),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 9 })).toEqual({ ok: false })
  })

  test('fails (ok:false) when identity cannot be resolved', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({
        '/user': new Response('no', { status: 403 }),
      }),
    })
    expect(await resolve({ workspace: WS, prNumber: 10 })).toEqual({ ok: false })
  })

  test('fails (ok:false) when no token is available', async () => {
    const resolve = createGithubEffectiveApprovalResolver({
      resolveToken: async () => null,
      fetchImpl: fetchStub({}),
    })
    expect(await resolve({ workspace: WS, prNumber: 11 })).toEqual({ ok: false })
  })
})

describe('github head-sha resolver', () => {
  test('returns head.sha from the single-PR endpoint', async () => {
    const resolve = createGithubHeadShaResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({ '/pulls/5': jsonResponse({ head: { sha: 'deadbeef' } }) }),
    })
    expect(await resolve({ workspace: WS, prNumber: 5 })).toBe('deadbeef')
  })

  test('returns null on a non-ok response so the cache degrades rather than strands', async () => {
    const resolve = createGithubHeadShaResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({ '/pulls/6': new Response('boom', { status: 500 }) }),
    })
    expect(await resolve({ workspace: WS, prNumber: 6 })).toBeNull()
  })

  test('returns null when no token is available', async () => {
    const resolve = createGithubHeadShaResolver({
      resolveToken: async () => null,
      fetchImpl: fetchStub({}),
    })
    expect(await resolve({ workspace: WS, prNumber: 7 })).toBeNull()
  })

  test('returns null when head.sha is missing or malformed', async () => {
    const resolve = createGithubHeadShaResolver({
      resolveToken: async () => 'tok',
      fetchImpl: fetchStub({ '/pulls/8': jsonResponse({ head: {} }) }),
    })
    expect(await resolve({ workspace: WS, prNumber: 8 })).toBeNull()
  })
})
