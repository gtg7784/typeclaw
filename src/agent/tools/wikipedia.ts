// Wikipedia OpenSearch API: free, official, no key, no rate limit on the free tier.
// Returns a JSON tuple [query, titles[], descriptions[], urls[]]. Descriptions are
// usually empty strings, so we don't expose them.

const OPENSEARCH_URL = 'https://en.wikipedia.org/w/api.php'

export type WikipediaResult = {
  title: string
  url: string
  snippet: string
}

export async function wikipediaSearch(query: string, limit: number, signal?: AbortSignal): Promise<WikipediaResult[]> {
  const params = new URLSearchParams({
    action: 'opensearch',
    search: query,
    limit: String(limit),
    format: 'json',
    namespace: '0',
  })
  const response = await fetch(`${OPENSEARCH_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'TypeClaw/0.1 (https://github.com/typeclaw/typeclaw)',
      Accept: 'application/json',
    },
    signal,
  })
  if (!response.ok) {
    throw new Error(`Wikipedia HTTP ${response.status} ${response.statusText}`)
  }
  const json = (await response.json()) as unknown
  return parseOpenSearch(json)
}

export function parseOpenSearch(json: unknown): WikipediaResult[] {
  if (!Array.isArray(json) || json.length < 4) return []
  const titles = asStringArray(json[1])
  const descriptions = asStringArray(json[2])
  const urls = asStringArray(json[3])
  const results: WikipediaResult[] = []
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i]
    const url = urls[i]
    if (!title || !url) continue
    results.push({ title, url, snippet: descriptions[i] ?? '' })
  }
  return results
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
