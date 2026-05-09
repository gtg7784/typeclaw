import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _setCurlBinaryForTest, fetchDdgHtml, parseDdgHtml } from './ddg'

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

describe('fetchDdgHtml', () => {
  // We test the curl-impersonate spawn path against a fake binary in a
  // tmpdir. AGENTS.md §5 prefers real implementations with controlled inputs
  // over mocks, so we hand-roll a shell script that stands in for
  // curl_chrome136 — this exercises the actual `spawn` codepath, including
  // exit-code handling, stdout/stderr piping, and abort propagation.
  let scratchDir: string

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'ddg-fetch-test-'))
  })

  afterEach(() => {
    _setCurlBinaryForTest(null)
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function installFakeBinary(script: string): void {
    const path = join(scratchDir, 'fake-curl')
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
    chmodSync(path, 0o755)
    _setCurlBinaryForTest(path)
  }

  test('returns stdout verbatim on exit 0', async () => {
    // given: fake binary that prints a fixed HTML body
    installFakeBinary("printf '<html>hello world</html>'")

    // when
    const html = await fetchDdgHtml('ignored')

    // then
    expect(html).toBe('<html>hello world</html>')
  })

  test('rejects with stderr detail when the binary exits non-zero', async () => {
    // given
    installFakeBinary('echo "boom" >&2; exit 7')

    // when / then
    await expect(fetchDdgHtml('q')).rejects.toThrow(/curl-impersonate exited 7/)
    await expect(fetchDdgHtml('q')).rejects.toThrow(/boom/)
  })

  test('reports "no stderr" when the binary fails silently', async () => {
    // given
    installFakeBinary('exit 1')

    // when / then
    await expect(fetchDdgHtml('q')).rejects.toThrow(/exited 1.*no stderr/)
  })

  test('passes query as POST form data with --data-urlencode', async () => {
    // given: fake binary records argv to a side file then prints empty body
    const argvFile = join(scratchDir, 'argv.txt')
    installFakeBinary(`printf '%s\\n' "$@" > ${argvFile}; printf ''`)

    // when
    await fetchDdgHtml('hello world')

    // then
    const argv = (await Bun.file(argvFile).text()).split('\n')
    expect(argv).toContain('-X')
    expect(argv).toContain('POST')
    expect(argv).toContain('--data-urlencode')
    expect(argv).toContain('q=hello world')
    expect(argv).toContain('https://lite.duckduckgo.com/lite/')
  })

  test('aborts when the AbortSignal fires', async () => {
    // given: fake binary sleeps long enough that we always abort first
    installFakeBinary('sleep 30')
    const controller = new AbortController()

    // when
    const promise = fetchDdgHtml('q', controller.signal)
    setTimeout(() => controller.abort(), 50)

    // then
    await expect(promise).rejects.toThrow()
  })
})
