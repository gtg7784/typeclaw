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
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://example.com/">Example Domain</a>
  </h2>
  <a class="result__snippet" href="https://example.com/">Example snippet text.</a>
</div>
`

describe('websearch tool: web (DuckDuckGo)', () => {
  test('hits DuckDuckGo HTML endpoint with POST and returns formatted results', async () => {
    // given
    fetchResponse = () => new Response(MINIMAL_DDG_HTML, { status: 200 })

    // when
    const result = await websearchTool.execute('id', { query: 'example' }, undefined, undefined, ctx)

    // then
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toBe('https://html.duckduckgo.com/html/')
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
    fetchResponse = () => new Response('<div class="anomaly-modal">…</div>', { status: 200 })

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
      <div class="result results_links results_links_deep web-result "><h2 class="result__title"><a class="result__a" href="https://a/">A</a></h2><a class="result__snippet" href="https://a/">a</a></div>
      <div class="result results_links results_links_deep web-result "><h2 class="result__title"><a class="result__a" href="https://b/">B</a></h2><a class="result__snippet" href="https://b/">b</a></div>
      <div class="result results_links results_links_deep web-result "><h2 class="result__title"><a class="result__a" href="https://c/">C</a></h2><a class="result__snippet" href="https://c/">c</a></div>
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
