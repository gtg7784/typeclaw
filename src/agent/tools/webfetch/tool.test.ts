import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { _setForceFallbackForTest } from './fetch'
import { webFetchTool } from './tool'
import type { WebFetchDetails } from './types'

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
  // Force the Bun.fetch fallback transport so these tool-level tests don't
  // accidentally hit a real curl-impersonate binary on dev/CI environments
  // where it happens to be installed. fetch.test.ts owns curl-path coverage.
  _setForceFallbackForTest(true)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  _setForceFallbackForTest(false)
})

const ctx = {} as Parameters<typeof webFetchTool.execute>[4]

function textOf(result: Awaited<ReturnType<typeof webFetchTool.execute>>): string {
  const part = result.content[0]
  return part?.type === 'text' ? part.text : ''
}

function detailsOf(result: Awaited<ReturnType<typeof webFetchTool.execute>>): WebFetchDetails {
  return result.details as WebFetchDetails
}

const ARTICLE_HTML = `
<!doctype html>
<html><head><title>Sample</title></head><body>
<article>
  <h1>Sample</h1>
  <p>This is a paragraph with enough body text for Readability to score the article positively and produce stable output across versions.</p>
  <p>A second paragraph adds reliability to the heuristic so the test does not depend on a single sentence.</p>
</article>
</body></html>`

describe('webfetch: URL handling', () => {
  test('rewrites bare hostnames to https://', async () => {
    fetchResponse = () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })

    await webFetchTool.execute('id', { url: 'example.com' }, undefined, undefined, ctx)

    expect(fetchCalls[0]?.url).toBe('https://example.com')
  })

  test('rejects non-http(s) schemes without a network call', async () => {
    fetchResponse = () => new Response('should not be called', { status: 500 })

    const result = await webFetchTool.execute('id', { url: 'file:///etc/passwd' }, undefined, undefined, ctx)

    expect(textOf(result)).toContain('http://')
    expect(detailsOf(result).error).toBe(true)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('webfetch: strategy auto-detection', () => {
  test('HTML content-type defaults to readability', async () => {
    fetchResponse = () =>
      new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/post' }, undefined, undefined, ctx)
    const details = detailsOf(result)

    expect(details.strategy).toBe('readability')
    expect(details.autoDetected).toBe(true)
    expect(textOf(result)).toContain('# Sample')
    expect(textOf(result)).toContain('paragraph with enough body text')
  })

  test('JSON content-type without explicit strategy returns a guidance error', async () => {
    fetchResponse = () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })

    const result = await webFetchTool.execute('id', { url: 'https://api.example.com/x' }, undefined, undefined, ctx)

    expect(textOf(result)).toMatch(/strategy: "jq"/)
    expect(detailsOf(result).error).toBe(true)
  })

  test('text/plain content-type defaults to raw', async () => {
    fetchResponse = () => new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/r.txt' }, undefined, undefined, ctx)

    expect(detailsOf(result).strategy).toBe('raw')
    expect(detailsOf(result).autoDetected).toBe(true)
    expect(textOf(result)).toBe('hello world')
  })
})

describe('webfetch: explicit strategies', () => {
  test('jq strategy executes a query against JSON response', async () => {
    fetchResponse = () =>
      new Response('{"items":[{"name":"a"},{"name":"b"}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://api.example.com/x', strategy: 'jq', query: '.items[].name' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toBe('"a"\n"b"')
    expect(detailsOf(result).strategy).toBe('jq')
    expect(detailsOf(result).autoDetected).toBe(false)
  })

  test('jq without query returns a missing-arg error before parsing', async () => {
    fetchResponse = () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://api.example.com/x', strategy: 'jq' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('Missing required arg `query`')
    expect(detailsOf(result).error).toBe(true)
  })

  test('selector strategy returns text of matching nodes', async () => {
    fetchResponse = () =>
      new Response('<html><body><span class="price">$9.99</span></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://shop.example.com/p', strategy: 'selector', selector: '.price' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('$9.99')
    expect(detailsOf(result).strategy).toBe('selector')
  })

  test('grep strategy filters lines from a text response', async () => {
    const body = ['alpha', 'beta', 'gamma alpha', 'delta'].join('\n')
    fetchResponse = () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/list.txt', strategy: 'grep', pattern: 'alpha' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('1:alpha')
    expect(textOf(result)).toContain('3:gamma alpha')
    expect(textOf(result)).not.toContain('beta')
  })

  test('snapshot strategy summarizes page structure', async () => {
    fetchResponse = () =>
      new Response('<html><body><nav><a href="/x">X</a></nav></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/', strategy: 'snapshot' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('navigation')
    expect(textOf(result)).toContain('link: "X" → /x')
  })

  test('raw strategy passes the body through unchanged', async () => {
    fetchResponse = () =>
      new Response('<html>raw body</html>', { status: 200, headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/', strategy: 'raw' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toBe('<html>raw body</html>')
  })
})

describe('webfetch: errors and limits', () => {
  test('non-2xx response surfaces the status', async () => {
    fetchResponse = () => new Response('nope', { status: 500, statusText: 'Internal Server Error' })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/' }, undefined, undefined, ctx)

    expect(textOf(result)).toContain('HTTP 500')
    expect(detailsOf(result).error).toBe(true)
  })

  test('truncates output when over the per-strategy cap and appends a footer', async () => {
    const big = 'x'.repeat(110_000)
    fetchResponse = () => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/big' }, undefined, undefined, ctx)
    const details = detailsOf(result)

    expect(details.truncated).toBe(true)
    expect(textOf(result)).toContain('[Output truncated:')
    expect(details.bytesOut).toBeLessThan(101_000)
  })

  test('does not throw on network failure (errors flow through details.error)', async () => {
    fetchResponse = () => {
      throw new Error('ECONNREFUSED')
    }

    const result = await webFetchTool.execute('id', { url: 'https://example.com/' }, undefined, undefined, ctx)

    expect(textOf(result)).toContain('ECONNREFUSED')
    expect(detailsOf(result).error).toBe(true)
  })
})
