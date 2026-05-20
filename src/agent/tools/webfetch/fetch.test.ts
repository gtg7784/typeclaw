import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _resetAvailabilityCacheForTest, _setCurlBinaryForTest } from '../curl-impersonate'
import { _setForceFallbackForTest, fetchWithLimits, normalizeUrl, parseMimeType, WebfetchError } from './fetch'

type FetchInput = Parameters<typeof fetch>[0]
type FetchArgs = { url: string; init: RequestInit | undefined }

let fetchCalls: FetchArgs[]
let fetchResponse: (args: FetchArgs) => Response | Promise<Response>
const originalFetch = globalThis.fetch

const CURL_META_SENTINEL = '\n--TYPECLAW-CURL-META-9c3f5e4d2a1b4f8e9c7a6b5d4e3f2a1b0--\n'

beforeEach(() => {
  fetchCalls = []
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const args = { url, init }
    fetchCalls.push(args)
    return fetchResponse(args)
  }) as typeof fetch
  // Default mode: force the Bun.fetch fallback so existing assertions on
  // mocked `globalThis.fetch` keep working. The impersonate-path tests
  // below opt into the curl path explicitly.
  _setForceFallbackForTest(true)
  _resetAvailabilityCacheForTest()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  _setForceFallbackForTest(false)
  _setCurlBinaryForTest(null)
  _resetAvailabilityCacheForTest()
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

describe('fetchWithLimits — Bun.fetch fallback path', () => {
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

  test('sends typeclaw User-Agent on the fallback path', async () => {
    fetchResponse = () => new Response('ok', { status: 200 })

    await fetchWithLimits('https://example.com', 30)

    const headers = fetchCalls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.['User-Agent']).toContain('typeclaw')
  })
})

describe('fetchWithLimits — curl-impersonate path', () => {
  let scratchDir: string

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'webfetch-curl-test-'))
    // Opt back into the real availability check (one of the tests below
    // installs a fake binary; another asserts the fallback fires when no
    // binary exists).
    _setForceFallbackForTest(false)
  })

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function installFakeBinary(script: string): void {
    const path = join(scratchDir, 'fake-curl')
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
    chmodSync(path, 0o755)
    _setCurlBinaryForTest(path)
    _resetAvailabilityCacheForTest()
  }

  test('uses curl-impersonate when the binary is available', async () => {
    // given: fake binary that emits a body + the metadata sentinel
    installFakeBinary(
      `printf '<html>ok</html>'; printf '${CURL_META_SENTINEL}200\nhttps://example.com/final\ntext/html; charset=utf-8\n15\n'`,
    )

    // when
    const result = await fetchWithLimits('https://example.com', 30)

    // then: the result came from curl, NOT from globalThis.fetch
    expect(result.body).toBe('<html>ok</html>')
    expect(result.contentType).toBe('text/html; charset=utf-8')
    expect(result.httpStatus).toBe(200)
    expect(result.finalUrl).toBe('https://example.com/final')
    expect(fetchCalls).toHaveLength(0)
  })

  test('translates curl non-2xx response into WebfetchError matching the fallback contract', async () => {
    // given: fake binary that emits a 403-shaped response (Akamai-style block)
    installFakeBinary(
      `printf '<html>blocked</html>'; printf '${CURL_META_SENTINEL}403\nhttps://example.com\ntext/html\n20\n'`,
    )

    // when / then
    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(WebfetchError)
    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/HTTP 403/)
  })

  test('falls back to Bun.fetch when curl-impersonate is not installed', async () => {
    // given: point the curl resolver at a path that doesn't exist, and have
    // globalThis.fetch ready to serve a known body
    _setCurlBinaryForTest('/nonexistent/curl_chrome136')
    _resetAvailabilityCacheForTest()
    fetchResponse = () => new Response('fallback body', { status: 200, headers: { 'content-type': 'text/plain' } })

    // when
    const result = await fetchWithLimits('https://example.com', 30)

    // then: globalThis.fetch was the actual transport
    expect(result.body).toBe('fallback body')
    expect(fetchCalls).toHaveLength(1)
  })
})
