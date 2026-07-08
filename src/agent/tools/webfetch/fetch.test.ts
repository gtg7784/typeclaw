import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import { _resetAvailabilityCacheForTest, _setCurlBinaryForTest } from '../curl-impersonate'
import { _setForceFallbackForTest, fetchWithLimits, normalizeUrl, parseMimeType, WebFetchError } from './fetch'

const onWindows = isWindows()

type FetchInput = Parameters<typeof fetch>[0]
type FetchArgs = { url: string; init: RequestInit | undefined }

let fetchCalls: FetchArgs[]
let fetchResponse: (args: FetchArgs) => Response | Promise<Response>
const originalFetch = globalThis.fetch

// Fake-curl shell-script template. We read the -w arg value (the curl
// write-out template containing the per-request random sentinel) directly
// out of argv by index — `printf '%s\\n' "$@"` collapses multi-line argv
// values into adjacent lines, but Bun spawns each argv element as a
// separate process argument, so positional `$N` accessors preserve the
// raw value verbatim. We find the position of '-w' via a small loop and
// emit `$N+1` as the template. Then substitute curl's %{...} codes for
// our static body. Same pattern as curl-impersonate.test.ts.
const FAKE_CURL = (body: string, status: number, finalUrl: string, contentType: string) => `
ARGV_FILE="\${SCRATCH_ARGV:-/tmp/argv.txt}"
printf '%s\\n' "$@" > "$ARGV_FILE"
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then
    j=$((i + 1))
    eval "WTPL=\\"\\\${$j}\\""
    break
  fi
  i=$((i + 1))
done
# WTPL is e.g. "\\n--TYPECLAW-CURL-META-<hex>--\\n%{http_code}\\n..."
# Replace curl's %{...} codes by hand.
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/${status}/' -e 's|%{url_effective}|${finalUrl}|' -e 's|%{content_type}|${contentType}|' -e 's/%{size_download}/${body.length}/')
printf '%s' '${body}'
printf '%s' "$RENDERED"
`

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
    expect(() => normalizeUrl('ftp://example.com')).toThrow(WebFetchError)
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(WebFetchError)
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(WebFetchError)
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

  test('throws WebFetchError on non-2xx status', async () => {
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

  test('wraps unexpected fetch errors as WebFetchError', async () => {
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

// POSIX-only fake shell binary without .exe/.cmd; Windows cannot spawn it (#899).
describe.skipIf(onWindows)('fetchWithLimits — curl-impersonate path', () => {
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
    const argvPath = join(scratchDir, 'argv.txt')
    // Short-circuit --version (the availability probe) to exit 0 regardless
    // of what the script body does on real invocations. Otherwise tests
    // that simulate an error exit (e.g. exit 56) would also fail the
    // availability check, silently falling through to the Bun.fetch path.
    writeFileSync(
      path,
      `#!/bin/sh\nSCRATCH_ARGV="${argvPath}"\nif [ "$1" = "--version" ]; then exit 0; fi\n${script}\n`,
      'utf8',
    )
    chmodSync(path, 0o755)
    _setCurlBinaryForTest(path)
    _resetAvailabilityCacheForTest()
  }

  test('uses curl-impersonate when the binary is available', async () => {
    // given: fake binary that round-trips the per-request sentinel
    installFakeBinary(FAKE_CURL('<html>ok</html>', 200, 'https://example.com/final', 'text/html; charset=utf-8'))

    // when
    const result = await fetchWithLimits('https://example.com', 30)

    // then: the result came from curl, NOT from globalThis.fetch
    expect(result.body).toBe('<html>ok</html>')
    expect(result.contentType).toBe('text/html; charset=utf-8')
    expect(result.httpStatus).toBe(200)
    expect(result.finalUrl).toBe('https://example.com/final')
    expect(fetchCalls).toHaveLength(0)
  })

  test('translates curl non-2xx response into WebFetchError matching the fallback contract', async () => {
    // given: fake binary that emits a 403-shaped response (Akamai-style block)
    installFakeBinary(FAKE_CURL('<html>blocked</html>', 403, 'https://example.com', 'text/html'))

    // when / then
    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(WebFetchError)
    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/HTTP 403/)
  })

  test('translates curl exit 28 (timeout) into a timeout-specific WebFetchError', async () => {
    // given: fake binary that exits with code 28 (Operation timeout)
    installFakeBinary('echo "Operation timed out after 30000 milliseconds" >&2; exit 28')

    // when / then
    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/timed out after 30s/)
  })

  test('translates curl exit 63 (content-length filesize overflow) into a too-large WebFetchError', async () => {
    installFakeBinary('echo "Maximum file size exceeded" >&2; exit 63')

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/Response too large/)
  })

  test('translates curl exit 56 + filesize stderr into a too-large WebFetchError', async () => {
    // given: fake emits the transfer-time variant Oracle verified empirically
    installFakeBinary('echo "Exceeded the maximum allowed file size (1) with 1 bytes" >&2; exit 56')

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/Response too large/)
  })

  test('does NOT misclassify generic exit 56 (recv failure) as filesize exceeded', async () => {
    installFakeBinary('echo "Recv failure: Connection reset by peer" >&2; exit 56')

    // when / then: it's a generic Fetch failed:, not "Response too large"
    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/Fetch failed.*exited 56/)
    await expect(fetchWithLimits('https://example.com', 30)).rejects.not.toThrow(/Response too large/)
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

// A fake curl that renders a single response including %{header_json}, so the
// primitive can parse Set-Cookie names. headerJson is baked in via a @@HJ@@
// placeholder to dodge sed metacharacter issues (see curl-impersonate.test.ts).
function fakeCurlWithHeaders(body: string, status: number, headerJson: string): string {
  return `
ARGV_FILE="\${SCRATCH_ARGV:-/tmp/argv.txt}"
printf '%s\\n' "$@" > "$ARGV_FILE"
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then
    j=$((i + 1))
    eval "WTPL=\\"\\\${$j}\\""
    break
  fi
  i=$((i + 1))
done
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/${status}/' -e 's|%{url_effective}|https://example.com|' -e 's|%{content_type}|text/html|' -e 's/%{size_download}/${body.length}/' -e 's|%{header_json}|@@HJ@@|')
printf '%s' '${body}'
printf '%s' "$RENDERED" | sed "s|@@HJ@@|$(printf '%s' '${headerJson.replace(/'/g, `'\\''`).replace(/\|/g, '\\\\|')}')|"
`
}

// POSIX-only fake shell binary. Windows cannot spawn it (#899).
describe.skipIf(onWindows)('fetchWithLimits — antibot cookie warmup', () => {
  let scratchDir: string
  let curlPath: string
  let countPath: string

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'webfetch-warmup-test-'))
    curlPath = join(scratchDir, 'fake-curl')
    countPath = join(scratchDir, 'count')
    _setForceFallbackForTest(false)
  })

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function install(script: string): void {
    writeFileSync(
      curlPath,
      `#!/bin/sh\nSCRATCH_ARGV="${join(scratchDir, 'argv.txt')}"\nif [ "$1" = "--version" ]; then exit 0; fi\n${script}\n`,
      'utf8',
    )
    chmodSync(curlPath, 0o755)
    _setCurlBinaryForTest(curlPath)
    _resetAvailabilityCacheForTest()
  }

  // A two-call fake: first invocation emits `first`, second emits `second`.
  // State is a counter file so the two curlImpersonate() spawns diverge.
  function installTwoCall(first: string, second: string): void {
    const dispatch = `
if [ "$1" = "--version" ]; then exit 0; fi
COUNT_FILE="${countPath}"
N=$(cat "$COUNT_FILE" 2>/dev/null || printf '0')
printf '%s' "$((N + 1))" > "$COUNT_FILE"
if [ "$N" = "0" ]; then
${first}
else
${second}
fi
`
    writeFileSync(curlPath, `#!/bin/sh\nSCRATCH_ARGV="${join(scratchDir, 'argv.txt')}"\n${dispatch}\n`, 'utf8')
    chmodSync(curlPath, 0o755)
    _setCurlBinaryForTest(curlPath)
    _resetAvailabilityCacheForTest()
  }

  test('plain 200: no warmup attempted flag surfaced as triggered', async () => {
    install(fakeCurlWithHeaders('<html>ok</html>', 200, '{"content-type":["text/html"]}'))

    const result = await fetchWithLimits('https://example.com', 30)

    expect(result.httpStatus).toBe(200)
    expect(result.antibotWarmup?.triggered).toBe(false)
  })

  test('403 with bot-manager Set-Cookie: replays once and returns the 200', async () => {
    const first = fakeCurlWithHeaders('blocked', 403, '{"set-cookie":["_abck=xyz; Path=/","bm_sz=abc"]}')
    const second = fakeCurlWithHeaders('<html>product</html>', 200, '{"content-type":["text/html"]}')
    installTwoCall(first, second)

    const result = await fetchWithLimits('https://example.com', 30)

    expect(result.httpStatus).toBe(200)
    expect(result.body).toBe('<html>product</html>')
    expect(result.antibotWarmup?.triggered).toBe(true)
    expect(result.antibotWarmup?.initialStatus).toBe(403)
    expect(result.antibotWarmup?.initialSetCookieNames).toEqual(['_abck', 'bm_sz'])
    expect(result.antibotWarmup?.replayStatus).toBe(200)
  })

  test('403 WITHOUT a bot-manager cookie: no replay, throws HTTP 403', async () => {
    install(fakeCurlWithHeaders('nope', 403, '{"set-cookie":["session=abc"]}'))

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/HTTP 403/)
  })

  test('401 with a bot cookie present: no replay (only 403 triggers), throws HTTP 401', async () => {
    install(fakeCurlWithHeaders('unauth', 401, '{"set-cookie":["_abck=xyz"]}'))

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/HTTP 401/)
  })

  test('403 with only a normal app cookie: no replay, throws HTTP 403', async () => {
    install(fakeCurlWithHeaders('blocked', 403, '{"set-cookie":["JSESSIONID=abc; Path=/"]}'))

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/HTTP 403/)
  })

  test('403 with bot cookie, replay still 403: throws final HTTP 403', async () => {
    const first = fakeCurlWithHeaders('blocked', 403, '{"set-cookie":["_abck=xyz"]}')
    const second = fakeCurlWithHeaders('blocked again', 403, '{"set-cookie":["_abck=xyz2"]}')
    installTwoCall(first, second)

    await expect(fetchWithLimits('https://example.com', 30)).rejects.toThrow(/HTTP 403/)
  })

  test('antibotWarmup="off": a bot-manager 403 is NOT replayed, throws HTTP 403', async () => {
    const first = fakeCurlWithHeaders('blocked', 403, '{"set-cookie":["_abck=xyz"]}')
    const second = fakeCurlWithHeaders('<html>product</html>', 200, '{"content-type":["text/html"]}')
    installTwoCall(first, second)

    await expect(fetchWithLimits('https://example.com', 30, undefined, 'off')).rejects.toThrow(/HTTP 403/)
  })

  test('replay is charged the remaining budget, not a fresh timeout', async () => {
    // given: the first request eats the whole 1s budget before returning a
    // bot-manager 403, so no time is left to replay.
    const first = `sleep 1.2\n${fakeCurlWithHeaders('blocked', 403, '{"set-cookie":["_abck=xyz"]}')}`
    const second = fakeCurlWithHeaders('<html>product</html>', 200, '{"content-type":["text/html"]}')
    installTwoCall(first, second)

    // when / then: it surfaces the initial 403 rather than spending a second
    // full budget on the replay.
    await expect(fetchWithLimits('https://example.com', 1)).rejects.toThrow(/HTTP 403/)

    // and: the replay never ran (counter advanced only for the first call).
    expect(readFileSync(countPath, 'utf8')).toBe('1')
  })
})
