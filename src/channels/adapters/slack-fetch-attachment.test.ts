import { describe, expect, test } from 'bun:test'

import { createSlackFetchAttachmentCallback, type SlackAdapterLogger } from './slack'

const logger: SlackAdapterLogger = { info: () => {}, warn: () => {}, error: () => {} }

function metadata(size: number) {
  return {
    id: 'F1',
    name: 'report.bin',
    title: 'report',
    mimetype: 'application/octet-stream',
    size,
    url_private: 'https://files.slack.com/files/report.bin',
    created: 1,
    user: 'U1',
  }
}

describe('slack user attachment downloads', () => {
  test('cancels an over-limit response body', async () => {
    let cancelled = false
    const callback = createSlackFetchAttachmentCallback({
      client: { getFileInfo: async () => metadata(4) },
      tokenRef: () => 'xoxc-secret',
      logger,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    })

    const result = await callback({ ref: 'F1', maxBytes: 4 })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('attachment is too large')
    expect(cancelled).toBe(true)
  })

  test('retains user bearer and session-cookie auth across trusted redirects', async () => {
    const seen: Array<{ url: string; auth: string | null; cookie: string | null }> = []
    const callback = createSlackFetchAttachmentCallback({
      client: { getFileInfo: async () => metadata(2) },
      tokenRef: () => 'xoxc-secret',
      cookieRef: () => 'session-cookie',
      logger,
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers)
        seen.push({
          url: String(input),
          auth: headers.get('authorization'),
          cookie: headers.get('cookie'),
        })
        return seen.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://cdn.slack-files.com/report.bin' } })
          : new Response('ok')
      },
    })

    expect((await callback({ ref: 'F1' })).ok).toBe(true)
    expect(seen.map((entry) => entry.auth)).toEqual(['Bearer xoxc-secret', 'Bearer xoxc-secret'])
    expect(seen.map((entry) => entry.cookie)).toEqual(['d=session-cookie', 'd=session-cookie'])
  })

  test('keeps bearer-only downloads cookie-free', async () => {
    let cookie: string | null = 'unobserved'
    const callback = createSlackFetchAttachmentCallback({
      client: { getFileInfo: async () => metadata(2) },
      tokenRef: () => 'xoxb-secret',
      logger,
      fetchImpl: async (_input, init) => {
        cookie = new Headers(init?.headers).get('cookie')
        return new Response('ok')
      },
    })

    expect((await callback({ ref: 'F1' })).ok).toBe(true)
    expect(cookie).toBeNull()
  })

  test('refuses untrusted redirects before any credential-bearing follow-up', async () => {
    const seen: string[] = []
    const callback = createSlackFetchAttachmentCallback({
      client: { getFileInfo: async () => metadata(2) },
      tokenRef: () => 'xoxc-secret',
      logger,
      fetchImpl: async (input) => {
        seen.push(String(input))
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/report.bin' } })
      },
    })

    expect((await callback({ ref: 'F1' })).ok).toBe(false)
    expect(seen).toEqual(['https://files.slack.com/files/report.bin'])
  })
})
