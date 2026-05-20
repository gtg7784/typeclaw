// Shared curl-impersonate spawn primitive.
//
// Why this exists: by 2026, every non-trivial public site (DDG, Reuters via
// Akamai, MarketWatch via Cloudflare, etc.) fingerprints incoming traffic at
// the TLS handshake (JA3/JA4) and HTTP/2 SETTINGS frame BEFORE any HTTP header
// is read. Bun's native fetch cannot match Chrome's handshake (upstream issue
// #11368), so outbound requests get gated by anomaly checks regardless of
// headers, body shape, or pacing. The fix is to shell out to curl-impersonate
// (lexiforest fork), which replays Chrome's exact TLS handshake, HTTP/2
// settings, and header ordering. Pinned by the typeclaw Dockerfile at
// /usr/local/bin/curl_chrome136 — see src/init/dockerfile.ts for the version
// and SHA pin.
//
// The original site of this code was ddg.ts; this file is the extraction so
// webfetch can share it. AGENTS.md explicitly warns against adding `-H`
// overrides because the curl_chrome wrapper already sends the full Chrome
// header set (correct ordering, sec-ch-ua, sec-fetch-*, accept-encoding,
// etc.) and any custom header corrupts the impersonation. The optional
// headers passed here are layered ON TOP of curl_chrome's defaults via `-H`,
// so use it ONLY for things curl can't infer (e.g. an explicit Authorization
// token, a custom API key). Don't override User-Agent, Accept, sec-* headers,
// or anything in curl_chrome's standard set.
//
// AGENTS.md §"Web search" describes why the spawn path is load-bearing for
// the DDG-specific case; the same reasoning applies to webfetch.

import { spawn } from 'bun'

export const CURL_IMPERSONATE_BINARY = 'curl_chrome136'
export const DEFAULT_TIMEOUT_SECONDS = 30

let curlBinary: string = CURL_IMPERSONATE_BINARY

// Test-only seam: lets *.test.ts point the spawn at a fake `curl_chrome136`
// script in a tmpdir so we exercise the real Bun.spawn path without depending
// on a curl-impersonate install on the test host. Production code never calls
// this — the module-level default above is what production sees.
export function _setCurlBinaryForTest(binary: string | null): void {
  curlBinary = binary ?? CURL_IMPERSONATE_BINARY
}

export type CurlImpersonateRequest = {
  url: string
  method?: 'GET' | 'POST' | 'HEAD'
  // Form-urlencoded body fields for POST. Each entry is passed as a separate
  // --data-urlencode argument so curl handles the encoding. Required if
  // method is 'POST' and you want a body.
  formFields?: Array<{ name: string; value: string }>
  // Extra headers layered on top of curl_chrome's Chrome 136 defaults. Use
  // sparingly — see the file header for the "don't override standard headers"
  // rule. Each entry becomes `-H "<name>: <value>"`.
  extraHeaders?: Record<string, string>
  // Hard cap on bytes accepted from the response (passed as --max-filesize).
  // The actual buffer is still bounded by the caller; this just makes curl
  // bail early instead of streaming gigabytes.
  maxBytes?: number
  timeoutSeconds?: number
  signal?: AbortSignal
}

export type CurlImpersonateResponse = {
  // Decoded response body. `--compressed` is always passed so we receive
  // plain bytes regardless of what content-encoding the server negotiated.
  body: string
  // Final URL after redirects (curl `-w '%{url_effective}'`).
  finalUrl: string
  // HTTP status of the final response (curl `-w '%{http_code}'`).
  httpStatus: number
  // Content-Type of the final response, lowercased and trimmed.
  contentType: string
  // Raw byte length of the body buffer (pre-decode).
  bytesIn: number
}

export class CurlImpersonateError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message)
    this.name = 'CurlImpersonateError'
  }
}

// `-w` write-out template. We emit a sentinel followed by status, final URL,
// content-type, and size, each on its own line, AFTER the body. This is the
// standard pattern for getting metadata back from curl without parsing
// response headers ourselves.
//
// The sentinel must be (a) extremely unlikely to appear in a real HTML/JSON
// response body, and (b) free of null bytes (Bun's spawn rejects argv
// entries with NULs). We pick a long ASCII tag with a UUID-shaped suffix:
// the chance of this exact 56-byte string appearing in a fetched page is
// vanishingly small in practice.
const METADATA_SENTINEL = '\n--TYPECLAW-CURL-META-9c3f5e4d2a1b4f8e9c7a6b5d4e3f2a1b0--\n'
const WRITE_OUT_TEMPLATE = `${METADATA_SENTINEL}%{http_code}\n%{url_effective}\n%{content_type}\n%{size_download}\n`

export async function curlImpersonate(req: CurlImpersonateRequest): Promise<CurlImpersonateResponse> {
  const timeoutSeconds = req.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  const method = req.method ?? 'GET'

  const cmd: string[] = [
    curlBinary,
    '--silent',
    '--show-error',
    // `--fail-with-body` makes curl exit non-zero on >=400 BUT still write
    // the body — so consumers see what the server actually said (useful for
    // 403/404 debugging) while still being able to detect failure via exit
    // code. We override exit-code handling below: we want callers to inspect
    // httpStatus themselves, so we DO NOT pass --fail-with-body here. Curl
    // exits 0 on a 404 with body, and the caller decides what to do.
    '--compressed',
    '--location', // follow redirects (essential for Akamai's _abck dance)
    '--max-redirs',
    '10',
    '--max-time',
    String(timeoutSeconds),
    '-w',
    WRITE_OUT_TEMPLATE,
    '-X',
    method,
  ]

  if (req.maxBytes !== undefined) {
    cmd.push('--max-filesize', String(req.maxBytes))
  }

  if (req.formFields) {
    for (const field of req.formFields) {
      cmd.push('--data-urlencode', `${field.name}=${field.value}`)
    }
  }

  if (req.extraHeaders) {
    for (const [name, value] of Object.entries(req.extraHeaders)) {
      cmd.push('-H', `${name}: ${value}`)
    }
  }

  cmd.push(req.url)

  // Spawn detached so the child becomes the leader of its own process group.
  // The curl-impersonate wrappers (curl_chrome136 et al.) are bash scripts
  // that call the real curl-impersonate binary WITHOUT `exec` — meaning the
  // wrapper is the parent and curl-impersonate is its child. On a plain
  // SIGKILL to the wrapper PID, the curl child becomes orphaned and keeps
  // the stdout pipe open until --max-time fires, turning a 50ms abort into
  // a 30s hang. process.kill(-pid) addresses the negative PID, which signals
  // the entire process group, killing both atomically. detached: true makes
  // the child the pgid leader so -pid is well-defined.
  const proc = spawn({
    cmd,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })

  const onAbort = () => {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
  req.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const [stdoutBuf, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (req.signal?.aborted) {
      throw new CurlImpersonateError('aborted', exitCode, stderr)
    }

    if (exitCode !== 0) {
      const detail = stderr.trim() || 'no stderr'
      throw new CurlImpersonateError(`curl-impersonate exited ${exitCode}: ${detail}`, exitCode, stderr)
    }

    return parseCurlOutput(stdoutBuf)
  } finally {
    req.signal?.removeEventListener('abort', onAbort)
  }
}

// Split the curl stdout into body + write-out metadata at the sentinel.
// The sentinel is appended AFTER curl finishes writing the body, so the
// split is unambiguous in well-formed output. If the sentinel doesn't appear
// at all (curl failed to emit -w, e.g. on a very early abort), we treat the
// whole buffer as the body with status 0.
function parseCurlOutput(buf: ArrayBuffer): CurlImpersonateResponse {
  const sentinelBytes = new TextEncoder().encode(METADATA_SENTINEL)
  const bytes = new Uint8Array(buf)

  const sentinelIndex = indexOfBytes(bytes, sentinelBytes)
  if (sentinelIndex < 0) {
    return {
      body: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      finalUrl: '',
      httpStatus: 0,
      contentType: '',
      bytesIn: bytes.byteLength,
    }
  }

  const bodyBytes = bytes.subarray(0, sentinelIndex)
  const metaBytes = bytes.subarray(sentinelIndex + sentinelBytes.byteLength)
  const meta = new TextDecoder('utf-8', { fatal: false }).decode(metaBytes).split('\n')

  const httpStatus = Number(meta[0]?.trim() ?? '0') || 0
  const finalUrl = (meta[1] ?? '').trim()
  const contentType = (meta[2] ?? '').trim().toLowerCase()
  const declaredBytes = Number(meta[3]?.trim() ?? '0') || bodyBytes.byteLength

  const body = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes)

  return {
    body,
    finalUrl,
    httpStatus,
    contentType,
    bytesIn: declaredBytes,
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0) return 0
  const end = haystack.byteLength - needle.byteLength
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

// Detect whether curl-impersonate is available on PATH. Used by fetch.ts to
// decide between the impersonating transport (production: container has the
// binary pinned in the image) and a Bun.fetch fallback (test/dev: no binary
// installed). The check is best-effort and cheap — we spawn `--version`
// and look at exit code. Cached per-process: the binary doesn't appear or
// disappear at runtime.
let availabilityCache: boolean | undefined

export async function isCurlImpersonateAvailable(): Promise<boolean> {
  if (availabilityCache !== undefined) return availabilityCache
  try {
    const proc = spawn({ cmd: [curlBinary, '--version'], stdout: 'ignore', stderr: 'ignore' })
    const code = await proc.exited
    availabilityCache = code === 0
  } catch {
    availabilityCache = false
  }
  return availabilityCache
}

export function _resetAvailabilityCacheForTest(): void {
  availabilityCache = undefined
}
