import { describe, expect, test } from 'bun:test'

import { createFetchAttachmentCallback, type TelegramBotAdapterLogger } from './telegram-bot'

function silentLogger(): TelegramBotAdapterLogger & { errors: string[] } {
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

describe('telegram-bot createFetchAttachmentCallback', () => {
  test('two-step download: getFile then api.telegram.org/file/bot<token>/<file_path>', async () => {
    const seen: string[] = []
    const cb = createFetchAttachmentCallback({
      token: 'BOT_TOKEN_XYZ',
      logger: silentLogger(),
      fetchImpl: fakeFetch((url) => {
        seen.push(url)
        if (url.includes('/getFile')) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: { file_id: 'AgAD', file_unique_id: 'u', file_path: 'documents/file_5.pdf' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response('PDFBYTES', { status: 200, headers: { 'content-type': 'application/pdf' } })
      }),
    })

    const result = await cb({ ref: 'AgAD' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(seen[0]).toContain('/getFile?file_id=AgAD')
    expect(seen[0]).toContain('/botBOT_TOKEN_XYZ/')
    expect(seen[1]).toBe('https://api.telegram.org/file/botBOT_TOKEN_XYZ/documents/file_5.pdf')
    expect(result.filename).toBe('file_5.pdf')
    expect(result.mimetype).toBe('application/pdf')
    expect(result.size).toBe(8)
    expect(result.buffer.toString('utf8')).toBe('PDFBYTES')
  })

  test('refuses refs that look like URLs so the bot token is never sent off-platform', async () => {
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
    expect(result.error).toContain('invalid Telegram file_id')
    expect(fetchCalled).toBe(false)
  })

  test('refs with slashes still hit api.telegram.org/getFile (encodeURIComponent contains them)', async () => {
    const seen: string[] = []
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch((url) => {
        seen.push(url)
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request: invalid file_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }),
    })

    const result = await cb({ ref: '../../etc/passwd' })

    // Critical SSRF property: even with `..` and `/` in ref, the request
    // is dispatched to api.telegram.org with the value URI-encoded as a
    // query parameter — never as a path component. Telegram echoes the
    // garbage back as a 400, surfaced to us as a structured error.
    expect(seen[0]).toBe('https://api.telegram.org/botT/getFile?file_id=..%2F..%2Fetc%2Fpasswd')
    expect(result.ok).toBe(false)
  })

  test('refuses empty refs without dispatching a fetch', async () => {
    let fetchCalled = false
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('', { status: 200 })
      }),
    })

    const result = await cb({ ref: '' })

    expect(result.ok).toBe(false)
    expect(fetchCalled).toBe(false)
  })

  test('surfaces non-ok getFile responses (e.g. expired file_id) as a structured error', async () => {
    const logger = silentLogger()
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger,
      fetchImpl: fakeFetch(
        () =>
          new Response(JSON.stringify({ ok: false, description: 'file not found' }), {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }),
      ),
    })

    const result = await cb({ ref: 'AgADStale' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('404')
    expect(logger.errors[0]).toContain('getFile failed')
  })

  test('surfaces api ok=false bodies as structured errors with the description field', async () => {
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch(
        () =>
          new Response(JSON.stringify({ ok: false, description: 'wrong file_id' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    })

    const result = await cb({ ref: 'AgADBogus' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('wrong file_id')
  })

  test('respects an explicit filename override even when the file_path has its own basename', async () => {
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch((url) => {
        if (url.includes('/getFile')) {
          return new Response(
            JSON.stringify({ ok: true, result: { file_id: 'AgAD', file_unique_id: 'u', file_path: 'photos/IMG.jpg' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response('z', { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }),
    })

    const result = await cb({ ref: 'AgAD', filename: 'renamed.jpg' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('renamed.jpg')
  })

  test('resolves over-limit reads as structured errors and cancels the body', async () => {
    let cancelled = false
    const cb = createFetchAttachmentCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch((url) => {
        if (url.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/large.bin' } }))
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8))
            },
            cancel() {
              cancelled = true
            },
          }),
        )
      }),
    })

    const result = await cb({ ref: 'AgAD', maxBytes: 4 })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('attachment is too large')
    expect(cancelled).toBe(true)
  })
})
