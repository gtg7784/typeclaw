import { describe, expect, test } from 'bun:test'

import { createFetchAttachmentCallback, type DiscordBotAdapterLogger } from './discord-bot'

function silentLogger(): DiscordBotAdapterLogger & { errors: string[] } {
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

function fakeFetch(responder: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(responder(typeof url === 'string' ? url : url.toString(), init))) as typeof fetch
}

describe('discord-bot createFetchAttachmentCallback', () => {
  test('downloads from cdn.discordapp.com and reports the buffer + URL basename + content-type', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const cb = createFetchAttachmentCallback({
      token: 'BOT_TOKEN_XYZ',
      logger: silentLogger(),
      fetchImpl: fakeFetch((url, init) => {
        const headers = new Headers(init?.headers)
        seen.push({ url, auth: headers.get('Authorization') })
        return new Response('discord-bytes', {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }),
    })

    const result = await cb({ ref: 'https://cdn.discordapp.com/attachments/c1/a1/diagram.png' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('diagram.png')
    expect(result.mimetype).toBe('image/png')
    expect(result.size).toBe(13)
    expect(result.buffer.toString('utf8')).toBe('discord-bytes')
    expect(seen[0]?.auth).toBe('Bot BOT_TOKEN_XYZ')
  })

  test('also accepts media.discordapp.net (Discord uses both hosts for proxied attachments)', async () => {
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch(() => new Response('ok', { status: 200 })),
    })

    const result = await cb({ ref: 'https://media.discordapp.net/attachments/c1/a1/img.jpg' })

    expect(result.ok).toBe(true)
  })

  test('refuses non-Discord hosts so the bot token is never sent to attacker-controlled URLs', async () => {
    let fetchCalled = false
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('should not happen', { status: 200 })
      }),
    })

    const result = await cb({ ref: 'https://evil.example.com/steal' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('not a Discord CDN URL')
    expect(fetchCalled).toBe(false)
  })

  test('rejects malformed URLs without dispatching a fetch', async () => {
    let fetchCalled = false
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('', { status: 200 })
      }),
    })

    const result = await cb({ ref: 'not-a-url' })

    expect(result.ok).toBe(false)
    expect(fetchCalled).toBe(false)
  })

  test('surfaces non-2xx CDN responses (e.g. expired signed URL) as a structured error', async () => {
    const logger = silentLogger()
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger,
      fetchImpl: fakeFetch(() => new Response('expired', { status: 403, statusText: 'Forbidden' })),
    })

    const result = await cb({ ref: 'https://cdn.discordapp.com/attachments/c1/a1/expired.png' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('403')
    expect(result.error).toContain('Forbidden')
    expect(logger.errors[0]).toContain('fetchAttachment failed')
  })

  test('respects an explicit filename override even when the URL has its own basename', async () => {
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch(() => new Response('z', { status: 200, headers: { 'content-type': 'text/plain' } })),
    })

    const result = await cb({
      ref: 'https://cdn.discordapp.com/attachments/c1/a1/upstream.png',
      filename: 'renamed.png',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('renamed.png')
  })
})
