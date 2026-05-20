import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CurlImpersonateError,
  _resetAvailabilityCacheForTest,
  _setCurlBinaryForTest,
  curlImpersonate,
  isCurlImpersonateAvailable,
} from './curl-impersonate'

const SENTINEL = '\n--TYPECLAW-CURL-META-9c3f5e4d2a1b4f8e9c7a6b5d4e3f2a1b0--\n'

describe('curlImpersonate', () => {
  let scratchDir: string

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'curl-impersonate-test-'))
    _resetAvailabilityCacheForTest()
  })

  afterEach(() => {
    _setCurlBinaryForTest(null)
    _resetAvailabilityCacheForTest()
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function installFakeBinary(script: string): void {
    const path = join(scratchDir, 'fake-curl')
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
    chmodSync(path, 0o755)
    _setCurlBinaryForTest(path)
  }

  test('parses body, status, finalUrl, contentType from sentinel-separated stdout', async () => {
    // given: fake binary that writes a body, then the sentinel, then metadata
    installFakeBinary(
      `printf '<html>hi</html>'; printf '${SENTINEL}200\nhttps://example.com/final\ntext/html; charset=utf-8\n14\n'`,
    )

    // when
    const result = await curlImpersonate({ url: 'https://example.com' })

    // then
    expect(result.body).toBe('<html>hi</html>')
    expect(result.httpStatus).toBe(200)
    expect(result.finalUrl).toBe('https://example.com/final')
    expect(result.contentType).toBe('text/html; charset=utf-8')
    expect(result.bytesIn).toBe(14)
  })

  test('returns body verbatim with status=0 when sentinel is absent', async () => {
    // given: legacy-style fake that emits only the body (e.g. very early abort)
    installFakeBinary("printf 'raw body without metadata'")

    // when
    const result = await curlImpersonate({ url: 'https://example.com' })

    // then
    expect(result.body).toBe('raw body without metadata')
    expect(result.httpStatus).toBe(0)
    expect(result.finalUrl).toBe('')
  })

  test('preserves a 404 body and reports httpStatus=404 (does NOT throw)', async () => {
    // given: server-emulating fake returns a 404-shaped response
    installFakeBinary(`printf 'not found'; printf '${SENTINEL}404\nhttps://example.com/missing\ntext/plain\n9\n'`)

    // when
    const result = await curlImpersonate({ url: 'https://example.com/missing' })

    // then: caller-decides-on-status policy
    expect(result.httpStatus).toBe(404)
    expect(result.body).toBe('not found')
  })

  test('throws CurlImpersonateError with stderr detail on non-zero exit', async () => {
    // given
    installFakeBinary('echo "tls handshake failed" >&2; exit 35')

    // when / then
    await expect(curlImpersonate({ url: 'https://example.com' })).rejects.toThrow(CurlImpersonateError)
    await expect(curlImpersonate({ url: 'https://example.com' })).rejects.toThrow(/exited 35/)
    await expect(curlImpersonate({ url: 'https://example.com' })).rejects.toThrow(/tls handshake failed/)
  })

  test('reports "no stderr" when the binary fails silently', async () => {
    installFakeBinary('exit 7')

    await expect(curlImpersonate({ url: 'https://example.com' })).rejects.toThrow(/exited 7.*no stderr/)
  })

  test('passes method, url, and form fields through argv', async () => {
    // given: fake captures argv to a side file
    const argvFile = join(scratchDir, 'argv.txt')
    installFakeBinary(`printf '%s\\n' "$@" > ${argvFile}; printf ''`)

    // when
    await curlImpersonate({
      url: 'https://example.com/search',
      method: 'POST',
      formFields: [
        { name: 'q', value: 'hello world' },
        { name: 'lang', value: 'en' },
      ],
    })

    // then
    const argv = (await Bun.file(argvFile).text()).split('\n')
    expect(argv).toContain('-X')
    expect(argv).toContain('POST')
    expect(argv).toContain('--data-urlencode')
    expect(argv).toContain('q=hello world')
    expect(argv).toContain('lang=en')
    expect(argv).toContain('https://example.com/search')
  })

  test('passes extra headers as -H arguments', async () => {
    const argvFile = join(scratchDir, 'argv.txt')
    installFakeBinary(`printf '%s\\n' "$@" > ${argvFile}; printf ''`)

    await curlImpersonate({
      url: 'https://example.com',
      extraHeaders: { Authorization: 'Bearer abc', 'X-Trace': 'xyz' },
    })

    const argv = (await Bun.file(argvFile).text()).split('\n')
    expect(argv).toContain('-H')
    expect(argv).toContain('Authorization: Bearer abc')
    expect(argv).toContain('X-Trace: xyz')
  })

  test('follows redirects by default (passes --location)', async () => {
    const argvFile = join(scratchDir, 'argv.txt')
    installFakeBinary(`printf '%s\\n' "$@" > ${argvFile}; printf ''`)

    await curlImpersonate({ url: 'https://example.com' })

    const argv = (await Bun.file(argvFile).text()).split('\n')
    expect(argv).toContain('--location')
    expect(argv).toContain('--max-redirs')
  })

  test('passes maxBytes as --max-filesize when provided', async () => {
    const argvFile = join(scratchDir, 'argv.txt')
    installFakeBinary(`printf '%s\\n' "$@" > ${argvFile}; printf ''`)

    await curlImpersonate({ url: 'https://example.com', maxBytes: 5_000_000 })

    const argv = (await Bun.file(argvFile).text()).split('\n')
    const idx = argv.indexOf('--max-filesize')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe('5000000')
  })

  test('aborts when the AbortSignal fires', async () => {
    // given: fake binary sleeps long enough that we always abort first
    installFakeBinary('sleep 30')
    const controller = new AbortController()

    // when
    const promise = curlImpersonate({ url: 'https://example.com', signal: controller.signal })
    setTimeout(() => controller.abort(), 50)

    // then
    await expect(promise).rejects.toThrow()
  })
})

describe('isCurlImpersonateAvailable', () => {
  beforeEach(() => {
    _resetAvailabilityCacheForTest()
  })

  afterEach(() => {
    _setCurlBinaryForTest(null)
    _resetAvailabilityCacheForTest()
  })

  test('returns true when the binary exits 0 on --version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'curl-available-test-'))
    try {
      const path = join(dir, 'fake-curl')
      writeFileSync(path, '#!/bin/sh\necho "curl 8.x impersonate"\nexit 0\n', 'utf8')
      chmodSync(path, 0o755)
      _setCurlBinaryForTest(path)

      const available = await isCurlImpersonateAvailable()

      expect(available).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns false when the binary is missing', async () => {
    _setCurlBinaryForTest('/nonexistent/path/to/curl_chrome136')

    const available = await isCurlImpersonateAvailable()

    expect(available).toBe(false)
  })

  test('caches the result for the life of the process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'curl-cache-test-'))
    try {
      const path = join(dir, 'fake-curl')
      writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8')
      chmodSync(path, 0o755)
      _setCurlBinaryForTest(path)

      const first = await isCurlImpersonateAvailable()
      // Swap to a bad binary — cached result should still be true
      _setCurlBinaryForTest('/nonexistent')
      const second = await isCurlImpersonateAvailable()

      expect(first).toBe(true)
      expect(second).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
