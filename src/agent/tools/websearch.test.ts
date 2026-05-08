import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { websearchTool } from './websearch'

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

const ctx = {} as Parameters<typeof websearchTool.execute>[4]

const MINIMAL_DDG_HTML = `
<tr><td><a rel="nofollow" href="https://example.com/" class='result-link'>Example Domain</a></td></tr>
<tr><td class='result-snippet'>Example snippet text.</td></tr>
`

describe('websearch tool: web (DuckDuckGo)', () => {
  test('hits DuckDuckGo HTML endpoint with POST and returns formatted results', async () => {
    // given
    fetchResponse = () => new Response(MINIMAL_DDG_HTML, { status: 200 })

    // when
    const result = await websearchTool.execute('id', { query: 'example' }, undefined, undefined, ctx)

    // then
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toBe('https://lite.duckduckgo.com/lite/')
    expect(fetchCalls[0]?.init?.method).toBe('POST')
    expect(fetchCalls[0]?.init?.body).toBe('q=example')

    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('Search results for "example" (web, 1)')
    expect(text).toContain('Example Domain')
    expect(text).toContain('https://example.com/')
    expect(text).toContain('Example snippet text.')

    const details = result.details as { source: string; count: number }
    expect(details.source).toBe('web')
    expect(details.count).toBe(1)
  })

  test('returns a clear error when DuckDuckGo serves a CAPTCHA page', async () => {
    // given
    fetchResponse = () =>
      new Response('<form id="challenge-form">Please verify you are a human</form>', { status: 200 })

    // when
    const result = await websearchTool.execute('id', { query: 'spam' }, undefined, undefined, ctx)

    // then
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/CAPTCHA/i)
    expect((result.details as { error?: boolean }).error).toBe(true)
  })

  test('returns a clear error on network failure (does not throw)', async () => {
    // given
    fetchResponse = () => {
      throw new Error('ECONNREFUSED')
    }

    // when
    const result = await websearchTool.execute('id', { query: 'x' }, undefined, undefined, ctx)

    // then
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('Search failed')
    expect(text).toContain('ECONNREFUSED')
  })

  test('returns a "no results" message when DuckDuckGo returns an empty SERP', async () => {
    // given
    fetchResponse = () => new Response('<html><body>nothing</body></html>', { status: 200 })

    // when
    const result = await websearchTool.execute('id', { query: 'zzznoresults' }, undefined, undefined, ctx)

    // then
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toBe('No results for "zzznoresults" on web.')
    expect((result.details as { count: number }).count).toBe(0)
  })

  test('respects the limit parameter', async () => {
    // given: 3 results in the SERP, ask for 2
    const html = `
      <tr><td><a href="https://a/" class='result-link'>A</a></td></tr>
      <tr><td class='result-snippet'>a</td></tr>
      <tr><td><a href="https://b/" class='result-link'>B</a></td></tr>
      <tr><td class='result-snippet'>b</td></tr>
      <tr><td><a href="https://c/" class='result-link'>C</a></td></tr>
      <tr><td class='result-snippet'>c</td></tr>
    `
    fetchResponse = () => new Response(html, { status: 200 })

    // when
    const result = await websearchTool.execute('id', { query: 'q', limit: 2 }, undefined, undefined, ctx)

    // then
    expect((result.details as { count: number }).count).toBe(2)
  })
})

describe('websearch tool: wikipedia', () => {
  test('routes wikipedia source to the OpenSearch JSON API', async () => {
    // given
    const json = ['ts', ['TypeScript'], [''], ['https://en.wikipedia.org/wiki/TypeScript']]
    fetchResponse = () =>
      new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })

    // when
    const result = await websearchTool.execute('id', { query: 'ts', source: 'wikipedia' }, undefined, undefined, ctx)

    // then
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toContain('en.wikipedia.org/w/api.php')
    expect(fetchCalls[0]?.url).toContain('action=opensearch')
    expect(fetchCalls[0]?.url).toContain('search=ts')

    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('Search results for "ts" (wikipedia, 1)')
    expect(text).toContain('TypeScript')
    expect((result.details as { source: string }).source).toBe('wikipedia')
  })
})

describe('websearch tool: input handling', () => {
  test('rejects an empty query before hitting the network', async () => {
    fetchResponse = () => new Response('should not be called', { status: 500 })

    const result = await websearchTool.execute('id', { query: '   ' }, undefined, undefined, ctx)

    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toBe('Query is empty.')
    expect(fetchCalls).toHaveLength(0)
  })
})
