// DDG's no-JS HTML endpoint is the only major engine that serves a parseable,
// key-free, registration-free SERP. We mimic a no-JS browser POST and parse the
// result page.
//
// TODO(engine-config): Make the search backend swappable via typeclaw.json once
// we have a concrete second engine in mind (self-hosted SearXNG, Brave with a
// user-supplied key, Tavily, ...). Defer until there's a real use case.

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/'

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
  const response = await fetch(DDG_HTML_URL, {
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

// Per SearXNG's `is_ddg_captcha`, the CAPTCHA page contains an "anomaly" modal.
function isCaptcha(html: string): boolean {
  return html.includes('anomaly-modal') || html.includes('class="anomaly"')
}

// Parses the SERP HTML. The structure is stable enough that regex is safer than
// pulling in cheerio: each result starts with `<div class="result results_links...">`
// and contains one `<a class="result__a" href="...">title</a>` and (usually) one
// `<a class="result__snippet" ...>snippet</a>`. We split on the opening tag rather
// than try to balance closing divs (DDG's nesting varies between page revisions).
export function parseDdgHtml(html: string): DdgResult[] {
  const results: DdgResult[] = []
  const opener = /<div class="result results_links[^"]*">/g
  const positions: number[] = []
  for (const match of html.matchAll(opener)) {
    if (match.index !== undefined) positions.push(match.index)
  }
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i] ?? 0
    const end = positions[i + 1] ?? html.length
    const block = html.slice(start, end)
    const result = parseResultBlock(block)
    if (result) results.push(result)
  }
  return results
}

function parseResultBlock(block: string): DdgResult | null {
  const titleMatch = /<a [^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
  if (!titleMatch) return null
  const url = decodeDdgUrl(titleMatch[1] ?? '')
  const title = stripHtml(titleMatch[2] ?? '').trim()

  const snippetMatch = /<a [^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)
  const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? '').trim() : ''

  if (!url || !title) return null
  return { title, url, snippet }
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
