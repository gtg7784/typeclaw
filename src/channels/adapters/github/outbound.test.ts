import { describe, expect, it } from 'bun:test'

import { createGithubOutboundCallback } from './outbound'

const logger = { info: () => {}, warn: () => {}, error: () => {} }

const fakeFetch = (responses: Record<string, { status: number; body: unknown }>) =>
  Object.assign(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const key = `${init?.method ?? 'GET'} ${String(url)}`
      const resp = responses[key] ?? { status: 404, body: { message: 'Not Found' } }
      return new Response(JSON.stringify(resp.body), { status: resp.status })
    },
    { preconnect: () => {} },
  )

describe('createGithubOutboundCallback', () => {
  it('posts issue and top-level PR comments through the issues comments endpoint', async () => {
    const cb = createGithubOutboundCallback({
      token: async () => 'tok',
      authType: 'app',
      logger,
      fetchImpl: fakeFetch({
        'POST https://api.github.com/repos/acme/project/issues/42/comments': { status: 201, body: { id: 1 } },
      }),
    })

    const result = await cb({
      adapter: 'github',
      workspace: 'acme/project',
      chat: 'pr:42',
      thread: null,
      text: 'hello',
    })

    expect(result).toEqual({ ok: true })
  })

  it('posts PR review thread replies through the pull comment replies endpoint', async () => {
    const cb = createGithubOutboundCallback({
      token: async () => 'tok',
      authType: 'app',
      logger,
      fetchImpl: fakeFetch({
        'POST https://api.github.com/repos/acme/project/pulls/42/comments/99/replies': { status: 201, body: { id: 2 } },
      }),
    })

    const result = await cb({
      adapter: 'github',
      workspace: 'acme/project',
      chat: 'pr:42',
      thread: '99',
      text: 'reply',
    })

    expect(result).toEqual({ ok: true })
  })

  it('rejects attachments', async () => {
    const cb = createGithubOutboundCallback({
      token: async () => 'tok',
      authType: 'app',
      logger,
      fetchImpl: fakeFetch({}),
    })

    const result = await cb({
      adapter: 'github',
      workspace: 'acme/project',
      chat: 'issue:1',
      text: 'x',
      attachments: [{ path: '/tmp/file.txt' }],
    })

    expect(result).toEqual({ ok: false, error: 'github-bot-does-not-support-attachments' })
  })

  describe('outbound 403 permission guidance', () => {
    it('decorates an Issues 403 with App-specific guidance when authType is app', async () => {
      const cb = createGithubOutboundCallback({
        token: async () => 'tok',
        authType: 'app',
        logger,
        fetchImpl: fakeFetch({
          'POST https://api.github.com/repos/acme/project/issues/42/comments': {
            status: 403,
            body: { message: 'Resource not accessible by integration' },
          },
        }),
      })

      const result = await cb({
        adapter: 'github',
        workspace: 'acme/project',
        chat: 'issue:42',
        thread: null,
        text: 'hello',
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('GitHub API 403')
      expect(result.error).toContain('Resource not accessible by integration')
      expect(result.error).toContain('Fix (GitHub App): the App needs "Issues" → "Read and write"')
      expect(result.error).toContain('https://github.com/settings/apps')
    })

    it('decorates a PR-reply 403 with the Pull requests permission, not Issues', async () => {
      const cb = createGithubOutboundCallback({
        token: async () => 'tok',
        authType: 'app',
        logger,
        fetchImpl: fakeFetch({
          'POST https://api.github.com/repos/acme/project/pulls/42/comments/99/replies': {
            status: 403,
            body: { message: 'Resource not accessible by integration' },
          },
        }),
      })

      const result = await cb({
        adapter: 'github',
        workspace: 'acme/project',
        chat: 'pr:42',
        thread: '99',
        text: 'hi',
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('"Pull requests" → "Read and write"')
      expect(result.error).not.toContain('"Issues" →')
    })

    it('decorates with PAT-specific guidance when authType is pat', async () => {
      const cb = createGithubOutboundCallback({
        token: async () => 'tok',
        authType: 'pat',
        logger,
        fetchImpl: fakeFetch({
          'POST https://api.github.com/repos/acme/project/issues/42/comments': {
            status: 403,
            body: { message: 'Resource not accessible by integration' },
          },
        }),
      })

      const result = await cb({
        adapter: 'github',
        workspace: 'acme/project',
        chat: 'issue:42',
        thread: null,
        text: 'hello',
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('Fix (fine-grained personal access token)')
      expect(result.error).toContain('"Issues" → "Read and write"')
      expect(result.error).toContain('classic personal access token')
      expect(result.error).not.toContain('Fix (GitHub App)')
    })

    it('does NOT decorate other 403 shapes (e.g. org SSO) so the wrong fix is not suggested', async () => {
      const cb = createGithubOutboundCallback({
        token: async () => 'tok',
        authType: 'app',
        logger,
        fetchImpl: fakeFetch({
          'POST https://api.github.com/repos/acme/project/issues/42/comments': {
            status: 403,
            body: { message: 'Resource protected by organization SAML enforcement.' },
          },
        }),
      })

      const result = await cb({
        adapter: 'github',
        workspace: 'acme/project',
        chat: 'issue:42',
        thread: null,
        text: 'hello',
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('GitHub API 403')
      expect(result.error).toContain('SAML enforcement')
      expect(result.error).not.toContain('Fix (GitHub App)')
      expect(result.error).not.toContain('Fix (fine-grained')
    })

    it('does NOT decorate non-403 errors', async () => {
      const cb = createGithubOutboundCallback({
        token: async () => 'tok',
        authType: 'app',
        logger,
        fetchImpl: fakeFetch({
          'POST https://api.github.com/repos/acme/project/issues/42/comments': {
            status: 422,
            body: { message: 'Validation Failed' },
          },
        }),
      })

      const result = await cb({
        adapter: 'github',
        workspace: 'acme/project',
        chat: 'issue:42',
        thread: null,
        text: 'hello',
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('GitHub API 422')
      expect(result.error).not.toContain('Fix (')
    })

    it('preserves the existing "GitHub API ${status}:" prefix so downstream parsers keep working', async () => {
      const cb = createGithubOutboundCallback({
        token: async () => 'tok',
        authType: 'app',
        logger,
        fetchImpl: fakeFetch({
          'POST https://api.github.com/repos/acme/project/issues/42/comments': {
            status: 403,
            body: { message: 'Resource not accessible by integration' },
          },
        }),
      })

      const result = await cb({
        adapter: 'github',
        workspace: 'acme/project',
        chat: 'issue:42',
        thread: null,
        text: 'hello',
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.startsWith('GitHub API 403:')).toBe(true)
    })
  })
})
