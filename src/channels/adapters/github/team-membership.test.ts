import { describe, expect, it } from 'bun:test'

import { createTeamMembershipChecker } from './team-membership'

describe('createTeamMembershipChecker', () => {
  it('returns true for an active membership', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ state: 'active' }), { status: 200 }))
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    expect(await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })).toBe(true)
  })

  it('returns false for a pending (non-active) membership', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ state: 'pending' }), { status: 200 }))
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    expect(await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })).toBe(false)
  })

  it('returns false on 404 (not a member)', async () => {
    const fetchImpl = fakeFetch(() => new Response('', { status: 404 }))
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    expect(await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })).toBe(false)
  })

  it('returns false on network error (fail-closed)', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('boom')
    })
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    expect(await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })).toBe(false)
  })

  it('caches results across calls', async () => {
    let calls = 0
    const fetchImpl = fakeFetch(() => {
      calls++
      return new Response(JSON.stringify({ state: 'active' }), { status: 200 })
    })
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })
    await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })
    expect(calls).toBe(1)
  })

  it('caches per (org, slug, login) tuple', async () => {
    let calls = 0
    const fetchImpl = fakeFetch(() => {
      calls++
      return new Response(JSON.stringify({ state: 'active' }), { status: 200 })
    })
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })
    await check({ org: 'acme', slug: 'maintainers', login: 'typeclaw-bot' })
    expect(calls).toBe(2)
  })
})

function fakeFetch(impl: () => Response | Promise<Response>): typeof fetch {
  const fn = async (): Promise<Response> => impl()
  return fn as unknown as typeof fetch
}
