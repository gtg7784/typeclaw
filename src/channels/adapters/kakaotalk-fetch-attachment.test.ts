import { describe, expect, test } from 'bun:test'

import type { KakaotalkAdapterLogger } from './kakaotalk'
import { createFetchAttachmentCallback } from './kakaotalk-fetch-attachment'

function recordingLogger(): KakaotalkAdapterLogger & {
  infos: string[]
  warns: string[]
  errors: string[]
} {
  const infos: string[] = []
  const warns: string[] = []
  const errors: string[] = []
  return {
    info: (m) => {
      infos.push(m)
    },
    warn: (m) => {
      warns.push(m)
    },
    error: (m) => {
      errors.push(m)
    },
    infos,
    warns,
    errors,
  }
}

function fakeFetch(responder: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(responder(typeof url === 'string' ? url : url.toString(), init))) as typeof fetch
}

const PHOTO_URL =
  'https://talk.kakaocdn.net/dna/byIE58/o3aSU13aSL/8O1voiq1dHdBlurQGOEWl4/i_e6095af16199.png?credential=zf3biCPbmWRjbqf40YGePFLewdou7TIK&expires=1778834720&signature=W%2BlSZ2yZvmKY5OrvQ%2B4H%2FTIUguc%3D'

describe('kakaotalk createFetchAttachmentCallback', () => {
  test('downloads from talk.kakaocdn.net without auth headers (the URL is pre-signed)', async () => {
    const seen: Array<{ url: string; headers: Headers }> = []
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch((url, init) => {
        seen.push({ url, headers: new Headers(init?.headers) })
        return new Response('kakao-bytes', {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }),
    })

    const result = await cb({ ref: PHOTO_URL })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('i_e6095af16199.png')
    expect(result.mimetype).toBe('image/png')
    expect(result.size).toBe(11)
    expect(result.buffer.toString('utf8')).toBe('kakao-bytes')
    // given KakaoCDN URLs carry their auth in query params, no
    // Authorization header should be sent — adding one would be
    // wasted noise and risks fingerprinting the agent.
    expect(seen[0]?.headers.get('Authorization')).toBeNull()
  })

  test('accepts every *.kakaocdn.net subdomain because file/video/audio land on different hosts', async () => {
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'application/pdf' } })),
    })

    const result = await cb({
      ref: 'https://dn-l-talk.kakaocdn.net/talkm/abc123/spec.pdf?credential=x&expires=1&signature=y',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('spec.pdf')
    expect(result.mimetype).toBe('application/pdf')
  })

  test('refuses non-kakaocdn hosts so the callback cannot be repurposed as a generic fetch', async () => {
    let fetchCalled = false
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('should not happen', { status: 200 })
      }),
    })

    const result = await cb({ ref: 'https://evil.example.com/steal' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('not a KakaoTalk CDN URL')
    expect(fetchCalled).toBe(false)
  })

  test('refuses lookalike hosts that suffix-match without a dot (evilkakaocdn.net)', async () => {
    let fetchCalled = false
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('', { status: 200 })
      }),
    })

    const result = await cb({ ref: 'https://evilkakaocdn.net/abc' })

    expect(result.ok).toBe(false)
    expect(fetchCalled).toBe(false)
  })

  test('refuses http:// (only signed https URLs are minted by LOCO)', async () => {
    let fetchCalled = false
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('', { status: 200 })
      }),
    })

    const result = await cb({ ref: 'http://talk.kakaocdn.net/anything' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('https')
    expect(fetchCalled).toBe(false)
  })

  test('rejects malformed URLs without dispatching a fetch', async () => {
    let fetchCalled = false
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('', { status: 200 })
      }),
    })

    const result = await cb({ ref: 'not-a-url' })

    expect(result.ok).toBe(false)
    expect(fetchCalled).toBe(false)
  })

  test('surfaces 403 with the expiry hint so the agent can tell the user to re-share the photo', async () => {
    const logger = recordingLogger()
    const cb = createFetchAttachmentCallback({
      logger,
      fetchImpl: fakeFetch(() => new Response('expired', { status: 403, statusText: 'Forbidden' })),
    })

    const result = await cb({ ref: PHOTO_URL })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('403')
    expect(result.error).toContain('expired pre-signed URL')
    expect(result.error).toContain('re-share')
    expect(logger.errors[0]).toContain('fetchAttachment failed')
  })

  test('surfaces non-403 errors verbatim without injecting the expiry hint', async () => {
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch(() => new Response('boom', { status: 500, statusText: 'Internal Server Error' })),
    })

    const result = await cb({ ref: PHOTO_URL })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('500')
    expect(result.error).not.toContain('expired pre-signed URL')
  })

  test('respects an explicit filename override even when the URL has its own basename', async () => {
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch(() => new Response('z', { status: 200, headers: { 'content-type': 'text/plain' } })),
    })

    const result = await cb({ ref: PHOTO_URL, filename: 'screenshot.png' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('screenshot.png')
  })

  test('falls back to "attachment" when the URL has no usable basename', async () => {
    const cb = createFetchAttachmentCallback({
      logger: recordingLogger(),
      fetchImpl: fakeFetch(() => new Response('z', { status: 200 })),
    })

    const result = await cb({ ref: 'https://talk.kakaocdn.net/' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('attachment')
  })

  test('returns a structured error when fetch itself throws (network failure)', async () => {
    const logger = recordingLogger()
    const cb = createFetchAttachmentCallback({
      logger,
      fetchImpl: fakeFetch(() => {
        throw new Error('ENETUNREACH')
      }),
    })

    const result = await cb({ ref: PHOTO_URL })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toBe('ENETUNREACH')
    expect(logger.errors[0]).toContain('fetchAttachment failed')
  })
})
