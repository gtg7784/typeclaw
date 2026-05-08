// DDG's no-JS "lite" endpoint is the only major engine that serves a
// parseable, key-free, registration-free SERP. We mimic a no-JS browser POST
// and parse the result page.
//
// We target `lite.duckduckgo.com/lite/` rather than `html.duckduckgo.com/html/`
// because `html` has been gated by the "anomaly-modal" CAPTCHA flow since
// early 2025 — even residential IPs hit it after 1-2 requests, since DDG
// fingerprints TLS at the transport layer and Bun's TLS stack does not match
// Chrome's. The `lite` endpoint exists for non-browser clients (text browsers,
// accessibility tools) and has historically been gated less aggressively. The
// markup is plain `<table>` rows with no CSS classes for layout — same
// underlying index, just less rendering.
//
// TODO(engine-config): Make the search backend swappable via typeclaw.json once
// we have a concrete second engine in mind (self-hosted SearXNG, Brave with a
// user-supplied key, Tavily, ...). Defer until there's a real use case.

const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/'

// Browser-ish UA + Sec-Fetch-Mode: navigate is what SearXNG uses to evade DDG's
// bot detection. Without these, the response is a CAPTCHA page.
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
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

async function fetchDdgHtml(query: string, signal?: AbortSignal): Promise<string> {
  const body = new URLSearchParams({ q: query }).toString()
  const response = await fetch(DDG_LITE_URL, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal,
  })
  if (!response.ok) {
    throw new Error(`DuckDuckGo HTTP ${response.status} ${response.statusText}`)
  }
  return await response.text()
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
