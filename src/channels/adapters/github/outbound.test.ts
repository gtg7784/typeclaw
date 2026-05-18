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
      token: 'tok',
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
      token: 'tok',
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
    const cb = createGithubOutboundCallback({ token: 'tok', logger, fetchImpl: fakeFetch({}) })

    const result = await cb({
      adapter: 'github',
      workspace: 'acme/project',
      chat: 'issue:1',
      text: 'x',
      attachments: [{ path: '/tmp/file.txt' }],
    })

    expect(result).toEqual({ ok: false, error: 'github-bot-does-not-support-attachments' })
  })
})
