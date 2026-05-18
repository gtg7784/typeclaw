import { describe, expect, it } from 'bun:test'

import { createGithubHistoryCallback } from './history'

describe('createGithubHistoryCallback', () => {
  it('fetches issue comments for a remembered workspace', async () => {
    const cb = createGithubHistoryCallback({
      token: async () => 'tok',
      workspaceForChat: () => 'acme/project',
      fetchImpl: Object.assign(
        async () =>
          Response.json([
            { id: 1, body: 'hello', created_at: '2026-01-01T00:00:00Z', user: { id: 2, login: 'alice' } },
          ]),
        { preconnect: () => {} },
      ),
    })

    const result = await cb({ chat: 'issue:5', thread: null, limit: 10 })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.messages[0]?.text).toBe('hello')
  })
})
