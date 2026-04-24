import { describe, expect, test } from 'bun:test'

import { parseDdgHtml } from './ddg'

const REAL_RESULT_HTML = `
<div id="links" class="results">
<div class="result results_links results_links_deep web-result ">
  <div class="links_main">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://bun.sh/">Bun &mdash; A fast all-in-one JavaScript runtime</a>
    </h2>
    <div class="result__extras">
      <div class="result__extras__url">
        <a class="result__url" href="https://bun.sh/">bun.sh</a>
      </div>
    </div>
    <a class="result__snippet" href="https://bun.sh/"><b>Bun</b> is a fast, all-in-one JavaScript &amp; <b>TypeScript</b> &#x27;toolkit&#x27;.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://github.com/oven-sh/bun">oven-sh/bun</a>
    </h2>
    <a class="result__snippet" href="https://github.com/oven-sh/bun">Incredibly fast JavaScript runtime.</a>
  </div>
</div>
</div>
`

describe('parseDdgHtml', () => {
  test('extracts title, url, snippet from each result block', () => {
    // when
    const results = parseDdgHtml(REAL_RESULT_HTML)

    // then
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Bun — A fast all-in-one JavaScript runtime',
      url: 'https://bun.sh/',
      snippet: "Bun is a fast, all-in-one JavaScript & TypeScript 'toolkit'.",
    })
    expect(results[1]).toEqual({
      title: 'oven-sh/bun',
      url: 'https://github.com/oven-sh/bun',
      snippet: 'Incredibly fast JavaScript runtime.',
    })
  })

  test('returns an empty array when there are no result blocks', () => {
    expect(parseDdgHtml('<html><body>nothing here</body></html>')).toEqual([])
  })

  test('strips inline highlight tags and decodes HTML entities in titles and snippets', () => {
    // given
    const html = `
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="https://example.com/">Foo &amp; Bar &lt;v2&gt;</a>
        </h2>
        <a class="result__snippet" href="https://example.com/">A &quot;quoted&quot; <b>snippet</b> with &#39;apostrophe&#39;.</a>
      </div>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results[0]?.title).toBe('Foo & Bar <v2>')
    expect(results[0]?.snippet).toBe('A "quoted" snippet with \'apostrophe\'.')
  })

  test('unwraps DDG redirect URLs (//duckduckgo.com/l/?uddg=...)', () => {
    // given
    const html = `
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpath&rut=abc">Real Site</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpath">snippet</a>
      </div>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results[0]?.url).toBe('https://real.example/path')
  })

  test('skips blocks with no title (defensive against malformed responses)', () => {
    // given
    const html = `
      <div class="result results_links results_links_deep web-result ">
        <a class="result__snippet" href="https://example.com/">snippet only</a>
      </div>
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="https://valid.example/">Valid</a>
        </h2>
      </div>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe('Valid')
  })
})
