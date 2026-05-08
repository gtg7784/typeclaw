import { describe, expect, test } from 'bun:test'

import { parseDdgHtml } from './ddg'

const REAL_RESULT_HTML = `
<html><body><table>
  <tr><td>1.&nbsp;</td>
    <td>
      <a rel="nofollow" href="https://bun.sh/" class='result-link'>Bun &mdash; A fast all-in-one JavaScript runtime</a>
    </td>
  </tr>
  <tr>
    <td class='result-snippet'>
      <b>Bun</b> is a fast, all-in-one JavaScript &amp; <b>TypeScript</b> &#x27;toolkit&#x27;.
    </td>
  </tr>
  <tr>
    <td>&nbsp;</td>
    <td>
      <span class='link-text'>bun.sh</span>
    </td>
  </tr>
  <tr><td>2.&nbsp;</td>
    <td>
      <a rel="nofollow" href="https://github.com/oven-sh/bun" class='result-link'>oven-sh/bun</a>
    </td>
  </tr>
  <tr>
    <td class='result-snippet'>
      Incredibly fast JavaScript runtime.
    </td>
  </tr>
</table></body></html>
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
      <tr><td><a rel="nofollow" href="https://example.com/" class='result-link'>Foo &amp; Bar &lt;v2&gt;</a></td></tr>
      <tr><td class='result-snippet'>A &quot;quoted&quot; <b>snippet</b> with &#39;apostrophe&#39;.</td></tr>
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
      <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpath&rut=abc" class='result-link'>Real Site</a></td></tr>
      <tr><td class='result-snippet'>snippet</td></tr>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results[0]?.url).toBe('https://real.example/path')
  })

  test('keeps results that have no snippet (snippet is optional in lite SERPs)', () => {
    // given: a single result with no following result-snippet row
    const html = `
      <tr><td><a rel="nofollow" href="https://valid.example/" class='result-link'>Valid</a></td></tr>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe('Valid')
    expect(results[0]?.url).toBe('https://valid.example/')
    expect(results[0]?.snippet).toBe('')
  })

  test('skips snippet rows that have no preceding result-link (defensive against malformed responses)', () => {
    // given
    const html = `
      <tr><td class='result-snippet'>orphan snippet with no link</td></tr>
      <tr><td><a rel="nofollow" href="https://valid.example/" class='result-link'>Valid</a></td></tr>
      <tr><td class='result-snippet'>real snippet</td></tr>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      title: 'Valid',
      url: 'https://valid.example/',
      snippet: 'real snippet',
    })
  })
})
