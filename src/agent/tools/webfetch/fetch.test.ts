import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { fetchWithLimits, normalizeUrl, parseMimeType, WebfetchError } from './fetch'

type FetchInput = Parameters<typeof fetch>[0]
type FetchArgs = { url: string; init: RequestInit | undefined }

let fetchCalls: FetchArgs[]
let fetchResponse: (args: FetchArgs) => Response | Promise<Response>
const originalFetch = globalThis.fetch

beforeEach(() => {
  fetchCalls = []
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const args = { url, init }
    fetchCalls.push(args)
    return fetchResponse(args)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('normalizeUrl', () => {
  test('passes http and https through unchanged', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  test('prepends https:// to bare hostnames', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('example.com/foo?bar=1')).toBe('https://example.com/foo?bar=1')
  })

  test('rejects non-http(s) schemes', () => {
    expect(() => normalizeUrl('ftp://example.com')).toThrow(WebfetchError)
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(WebfetchError)
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(WebfetchError)
  })

  test('trims whitespace', () => {
    expect(normalizeUrl('   https://example.com   ')).toBe('https://example.com')
  })
})

describe('parseMimeType', () => {
  test('extracts mime type from content-type header', () => {
    expect(parseMimeType('text/html; charset=utf-8')).toBe('text/html')
    expect(parseMimeType('application/json')).toBe('application/json')
    expect(parseMimeType('TEXT/PLAIN; charset=us-ascii')).toBe('text/plain')
    expect(parseMimeType('')).toBe('')
  })
})

describe('fetchWithLimits', () => {
  test('returns body, content-type, status, and final URL on success', async () => {
    fetchResponse = () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })

    const result = await fetchWithLimits('https://example.com', 30)

    expect(result.body).toBe('hello')
    expect(result.contentType).toBe('text/plain')
    expect(result.httpStatus).toBe(200)
    expect(result.bytesIn).toBe(5)
  })

  test('throws WebfetchError on non-2xx status', async () => {
    fetchResponse = () => new Response('not found', { status: 404, statusText: 'Not Found' })

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/HTTP 404/)
  })

  test('rejects responses larger than MAX_RESPONSE_BYTES via content-length header', async () => {
    fetchResponse = () => new Response('x', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } })

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/Response too large/)
  })

  test('rejects responses larger than MAX_RESPONSE_BYTES via actual byte size', async () => {
    const big = new Uint8Array(6 * 1024 * 1024)
    fetchResponse = () => new Response(big, { status: 200 })

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/Response too large/)
  })

  test('reports timeout with seconds in the error message', async () => {
    fetchResponse = (args) =>
      new Promise((_resolve, reject) => {
        args.init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })

    await expect(fetchWithLimits('https://example.com', 0.05)).rejects.toThrow(/timed out after 0\.05s/)
  })

  test('wraps unexpected fetch errors as WebfetchError', async () => {
    fetchResponse = () => {
      throw new Error('ECONNREFUSED')
    }

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/Fetch failed: ECONNREFUSED/)
  })

  test('sends typeclaw User-Agent', async () => {
    fetchResponse = () => new Response('ok', { status: 200 })

    await fetchWithLimits('https://example.com', 30)

    const headers = fetchCalls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.['User-Agent']).toContain('typeclaw')
  })
})
