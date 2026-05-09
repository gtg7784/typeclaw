// DDG's no-JS "lite" endpoint is the only major engine that serves a
// parseable, key-free, registration-free SERP. We POST a query and parse the
// resulting <table> markup.
//
// We target `lite.duckduckgo.com/lite/` rather than `html.duckduckgo.com/html/`
// because `html` is gated by the interactive "duck picker" CAPTCHA after a
// single bad fingerprint match. `lite` exists for non-browser clients (text
// browsers, accessibility tools) and historically gates less aggressively —
// but as of 2026 it ALSO fingerprints at the TLS layer (JA3/JA4) and the
// HTTP/2 SETTINGS frame, well before any HTTP header is read. Bun's native
// fetch cannot match Chrome's handshake (upstream issue #11368), so requests
// from `fetch()` get gated regardless of headers, body shape, or pacing —
// confirmed empirically over a multi-hour session against a single home IP
// where real Chromium succeeded continuously while every fetch variant got
// 202 anomaly-modal or HTTP-200-with-anomaly responses.
//
// The fix is to shell out to `curl-impersonate` (lexiforest fork), which
// replays Chrome's exact TLS handshake + HTTP/2 settings + header ordering.
// The binary is installed by the typeclaw Dockerfile (see
// src/init/dockerfile.ts CURL_IMPERSONATE_* constants) at /usr/local/bin/
// and invoked via the version-pinned wrapper `curl_chrome136`.
//
// Why no `-H` overrides: curl_chrome136 already sends the full Chrome 136
// header set with correct ordering, sec-ch-ua values, etc. Adding our own
// headers would corrupt the impersonation. The previous code's
// BROWSER_HEADERS const has been removed for the same reason.

import { spawn } from 'bun'

const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/'
const CURL_IMPERSONATE_BINARY = 'curl_chrome136'
const REQUEST_TIMEOUT_SECONDS = 30

let curlBinary = CURL_IMPERSONATE_BINARY

// Test-only seam: lets ddg.test.ts and websearch.test.ts point the spawn
// at a fake `curl_chrome136` script in a tmpdir so we exercise the real
// Bun.spawn path without depending on a curl-impersonate install on the
// test host. Production code never calls this — the const-import default
// above is what production sees.
export function _setCurlBinaryForTest(binary: string | null): void {
  curlBinary = binary ?? CURL_IMPERSONATE_BINARY
}

export type DdgResult = {
  title: string
  url: string
  snippet: string
}

export async function ddgSearch(query: string, limit: number, signal?: AbortSignal): Promise<DdgResult[]> {
  const html = await fetchDdgHtml(query, signal)
  if (isCaptcha(html)) {
    throw new DdgCaptchaError()
  }
  return parseDdgHtml(html).slice(0, limit)
}

export class DdgCaptchaError extends Error {
  constructor() {
    super('DuckDuckGo returned a CAPTCHA page (rate-limited). Try again later or with a different query.')
    this.name = 'DdgCaptchaError'
  }
}

export async function fetchDdgHtml(query: string, signal?: AbortSignal): Promise<string> {
  // Spawn detached so the child becomes the leader of its own process group.
  // The curl-impersonate wrappers (curl_chrome136 et al.) are bash scripts
  // that call the real curl-impersonate binary WITHOUT `exec` — meaning the
  // wrapper is the parent and curl-impersonate is its child. On a plain
  // SIGKILL to the wrapper PID, the curl child becomes orphaned and keeps
  // the stdout pipe open until --max-time fires (30s default), turning a
  // 50ms abort into a 30s hang. process.kill(-pid) addresses the negative
  // PID, which signals the entire process group, killing both the wrapper
  // and the inner curl atomically. detached: true is what makes the child
  // the pgid leader so -pid is well-defined; without it, the child shares
  // our pgid and we'd nuke our own process.
  const proc = spawn({
    cmd: [
      curlBinary,
      '--silent',
      '--show-error',
      '--fail-with-body',
      '--compressed',
      '--max-time',
      String(REQUEST_TIMEOUT_SECONDS),
      '-X',
      'POST',
      '--data-urlencode',
      `q=${query}`,
      DDG_LITE_URL,
    ],
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
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (signal?.aborted) {
      throw new Error('aborted')
    }
    if (exitCode !== 0) {
      const detail = stderr.trim() || 'no stderr'
      throw new Error(`curl-impersonate exited ${exitCode}: ${detail}`)
    }
    return stdout
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

// The `lite` endpoint's CAPTCHA page is plainer than `html`'s anomaly-modal:
// it returns either an HTTP error (caught above) or a "challenge-form" page
// asking the user to verify they're human. We also keep the legacy anomaly
// markers as a belt-and-suspenders check in case DDG ever unifies the flows.
function isCaptcha(html: string): boolean {
  return (
    html.includes('challenge-form') ||
    html.includes('Please verify you are a human') ||
    html.includes('anomaly-modal') ||
    html.includes('class="anomaly"')
  )
}

// Parses the lite SERP HTML. Each result is a triplet of `<tr>` rows:
//   1. <a class='result-link' href="…">Title</a>
//   2. <td class='result-snippet'>snippet…</td>
//   3. <span class='link-text'>display.url</span>
// Rows 2 and 3 are sometimes absent (e.g. ad placements without snippets), so
// we anchor on `result-link` and walk forward looking for the optional
// snippet within a small window. Sponsored entries are wrapped in adjacent
// rows that don't carry `result-link`, so they fall out naturally.
export function parseDdgHtml(html: string): DdgResult[] {
  const results: DdgResult[] = []
  const linkRegex = /<a\s+[^>]*href=(['"])([^'"]+)\1[^>]*class=(['"])result-link\3[^>]*>([\s\S]*?)<\/a>/g
  for (const match of html.matchAll(linkRegex)) {
    const url = decodeDdgUrl(match[2] ?? '')
    const title = stripHtml(match[4] ?? '').trim()
    if (!url || !title) continue

    const blockEnd = match.index !== undefined ? match.index + 2000 : html.length
    const blockStart = match.index !== undefined ? match.index : 0
    const window = html.slice(blockStart, blockEnd)
    const snippetMatch = /<td\s+[^>]*class=(['"])result-snippet\1[^>]*>([\s\S]*?)<\/td>/.exec(window)
    const snippet = snippetMatch ? stripHtml(snippetMatch[2] ?? '').trim() : ''

    results.push({ title, url, snippet })
  }
  return results
}

// DDG sometimes wraps result URLs in a redirect like
//   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=...
// Unwrap when present so the model sees the real destination.
function decodeDdgUrl(href: string): string {
  if (!href) return ''
  const normalized = href.startsWith('//') ? `https:${href}` : href
  try {
    const parsed = new URL(normalized)
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
      const inner = parsed.searchParams.get('uddg')
      if (inner) return inner
    }
    return parsed.toString()
  } catch {
    return href
  }
}

function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}
