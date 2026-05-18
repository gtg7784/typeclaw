import { describe, expect, it } from 'bun:test'

import { createGithubMembershipResolver } from './membership'

describe('createGithubMembershipResolver', () => {
  it('counts collaborator humans and bots', async () => {
    const resolver = createGithubMembershipResolver({
      token: async () => 'tok',
      fetchImpl: Object.assign(async () => Response.json([{ type: 'User' }, { type: 'Bot' }]), {
        preconnect: () => {},
      }),
    })

    const result = await resolver({ adapter: 'github', workspace: 'acme/project', chat: 'issue:1', thread: null })

    expect(result).toMatchObject({ humans: 1, bots: 1, truncated: false })
  })
})
