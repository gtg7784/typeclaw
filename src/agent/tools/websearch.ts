import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { ddgSearch, DdgCaptchaError, type DdgResult } from './ddg'
import { wikipediaSearch, type WikipediaResult } from './wikipedia'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

type WebsearchDetails = {
  query: string
  source: 'web' | 'wikipedia' | 'none'
  count: number
  results: (DdgResult | WikipediaResult)[]
  error?: boolean
  message?: string
}

export const websearchTool = defineTool({
  name: 'websearch',
  label: 'Web Search',
  description:
    'Search the public web. Returns a ranked list of {title, url, snippet} entries. Use `source: "wikipedia"` for encyclopedic lookups; otherwise default to general web results from DuckDuckGo. Pair this with the `read` tool by visiting URLs you find with `bash` (curl) when you need full page contents.\n' +
    'If `spawn_subagent` is available to you, PREFER delegating to the `scout` subagent by default: spawn it whenever the research is non-trivial (more than 1-2 queries, any "across multiple sources" framing, or follow-up fetches of the results). Scout runs `websearch`/`webfetch` in its own context window and returns a distilled, citation-backed answer, so the search churn never pollutes yours. Only call this tool directly for a single query whose top result you will cite immediately — or whenever you cannot spawn subagents (e.g. you are yourself a subagent), in which case run the searches here.',
  parameters: Type.Object({
    query: Type.String({ description: 'The search query.' }),
    limit: Type.Optional(
      Type.Integer({
        description: `Max number of results to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      }),
    ),
    source: Type.Optional(
      Type.Union([Type.Literal('web'), Type.Literal('wikipedia')], {
        description: 'Which engine to query. Defaults to "web" (DuckDuckGo).',
      }),
    ),
  }),

  async execute(_toolCallId, params, signal) {
    const query = params.query.trim()
    if (!query) {
      return errorResult('Query is empty.')
    }
    const limit = clampLimit(params.limit)
    const source = params.source ?? 'web'

    try {
      const results =
        source === 'wikipedia' ? await wikipediaSearch(query, limit, signal) : await ddgSearch(query, limit, signal)
      return successResult(query, source, results)
    } catch (error) {
      if (error instanceof DdgCaptchaError) {
        return errorResult(error.message)
      }
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(`Search failed: ${message}`)
    }
  },
})

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(value)), MAX_LIMIT)
}

function successResult(query: string, source: 'web' | 'wikipedia', results: DdgResult[] | WikipediaResult[]) {
  const details: WebsearchDetails = { query, source, count: results.length, results }
  if (results.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No results for "${query}" on ${source}.` }],
      details,
    }
  }

  const lines = [`Search results for "${query}" (${source}, ${results.length}):`, '']
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`)
    lines.push(`   ${result.url}`)
    if (result.snippet) lines.push(`   ${result.snippet}`)
    lines.push('')
  })

  return {
    content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
    details,
  }
}

function errorResult(message: string) {
  const details: WebsearchDetails = { query: '', source: 'none', count: 0, results: [], error: true, message }
  return {
    content: [{ type: 'text' as const, text: message }],
    details,
  }
}
