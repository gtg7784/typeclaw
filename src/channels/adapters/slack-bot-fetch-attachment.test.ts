import { describe, expect, test } from 'bun:test'

import { createFetchAttachmentCallback, type SlackBotAdapterLogger } from './slack-bot'

function silentLogger(): SlackBotAdapterLogger & { errors: string[] } {
  const errors: string[] = []
  return {
    info: () => {},
    warn: () => {},
    error: (m) => {
      errors.push(m)
    },
    errors,
  }
}

describe('slack-bot createFetchAttachmentCallback', () => {
  test('hands a valid Fxxxx file id to the SDK and surfaces the buffer + metadata to the router', async () => {
    const logger = silentLogger()
    const cb = createFetchAttachmentCallback({
      client: {
        getFileInfo: async (fileId) => slackFile(fileId, 17),
      },
      token: 'xoxb-secret',
      fetchImpl: async () => new Response('bytes-for-F12345', { headers: { 'content-type': 'image/png' } }),
      logger,
    })

    const result = await cb({ ref: 'F12345' })

    expect(result).toEqual({
      ok: true,
      buffer: Buffer.from('bytes-for-F12345'),
      filename: 'diagram.png',
      mimetype: 'image/png',
      size: 16,
    })
    expect(logger.errors).toEqual([])
  })

  test('respects an explicit filename override (lets the agent rename inflight)', async () => {
    const cb = createFetchAttachmentCallback({
      client: {
        getFileInfo: async () => slackFile('F1', 1, 'upstream.png'),
      },
      token: 'xoxb-secret',
      fetchImpl: async () => new Response('x', { headers: { 'content-type': 'image/png' } }),
      logger: silentLogger(),
    })

    const result = await cb({ ref: 'F1', filename: 'renamed.png' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('renamed.png')
  })

  test('rejects refs that are not Slack file ids without calling the SDK (prevents url leakage)', async () => {
    let downloadCalled = false
    const cb = createFetchAttachmentCallback({
      client: {
        getFileInfo: async () => slackFile('F1', 1),
      },
      token: 'xoxb-secret',
      fetchImpl: async () => {
        downloadCalled = true
        throw new Error('should not be called')
      },
      logger: silentLogger(),
    })

    const result = await cb({ ref: 'https://files.slack.com/private/F1/diagram.png' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('invalid Slack file id')
    expect(downloadCalled).toBe(false)
  })

  test('returns a structured error when the SDK download throws', async () => {
    const logger = silentLogger()
    const cb = createFetchAttachmentCallback({
      client: {
        getFileInfo: async () => {
          throw new Error('files.info: file_not_found')
        },
      },
      token: 'xoxb-secret',
      logger,
    })

    const result = await cb({ ref: 'F404' })

    expect(result).toEqual({ ok: false, error: 'files.info: file_not_found' })
    expect(logger.errors[0]).toContain('downloadFile failed for F404')
  })

  test('cancels an over-limit stream and returns a structured size error', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8))
      },
      cancel() {
        cancelled = true
      },
    })
    const cb = createFetchAttachmentCallback({
      client: { getFileInfo: async () => slackFile('F1', 4) },
      token: 'xoxb-secret',
      fetchImpl: async () => new Response(body),
      logger: silentLogger(),
    })

    const result = await cb({ ref: 'F1', maxBytes: 4 })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('attachment is too large')
    expect(cancelled).toBe(true)
  })

  test('retains bearer auth across trusted Slack redirects', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const cb = createFetchAttachmentCallback({
      client: { getFileInfo: async () => slackFile('F1', 2) },
      token: 'xoxb-secret',
      fetchImpl: async (input, init) => {
        const url = String(input)
        seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
        return seen.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://cdn.slack-edge.com/file' } })
          : new Response('ok', { headers: { 'content-type': 'application/octet-stream' } })
      },
      logger: silentLogger(),
    })

    expect((await cb({ ref: 'F1' })).ok).toBe(true)
    expect(seen).toEqual([
      { url: 'https://files.slack.com/files/diagram.png', auth: 'Bearer xoxb-secret' },
      { url: 'https://cdn.slack-edge.com/file', auth: 'Bearer xoxb-secret' },
    ])
  })

  test('refuses an untrusted redirect without sending credentials to it', async () => {
    const seen: string[] = []
    const cb = createFetchAttachmentCallback({
      client: { getFileInfo: async () => slackFile('F1', 2) },
      token: 'xoxb-secret',
      fetchImpl: async (input) => {
        seen.push(String(input))
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } })
      },
      logger: silentLogger(),
    })

    const result = await cb({ ref: 'F1' })

    expect(result.ok).toBe(false)
    expect(seen).toEqual(['https://files.slack.com/files/diagram.png'])
  })
})

function slackFile(id: string, size: number, name = 'diagram.png') {
  return {
    id,
    name,
    title: 'file',
    mimetype: 'image/png',
    size,
    url_private: `https://files.slack.com/files/${name}`,
    created: 1700000000,
    user: 'U123',
  }
}
