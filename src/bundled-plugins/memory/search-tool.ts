import { z } from 'zod'

import { defineTool } from '@/plugin'

import { loadAllShards, type TopicShard } from './load-shards'

const DEFAULT_MAX_RESULTS = 10
const EXCERPT_CONTEXT_LINES = 3

type MemorySearchMatch = {
  shardPath: string
  slug: string
  heading: string
  excerpt: string
  fullBody?: string
}

type MemorySearchResult = { matches: MemorySearchMatch[]; truncatedAt?: number } | { error: string }

type Matcher = (haystack: string) => boolean

export const memorySearchTool = defineTool({
  description:
    'Search long-term memory topic shards under memory/topics using case-insensitive substring matching by default or a JavaScript regex when asRegex=true. Returns shard paths, headings, and contextual excerpts; full=true includes full shard bodies.',
  parameters: z.object({
    query: z.string(),
    asRegex: z.boolean().default(false),
    full: z.boolean().default(false),
    maxResults: z.number().int().min(0).default(DEFAULT_MAX_RESULTS),
  }),
  async execute({ query, asRegex, full, maxResults }, ctx) {
    const matcherOrError = buildMatcher(query, asRegex)
    if (typeof matcherOrError === 'string') {
      return resultToToolResult({ error: matcherOrError })
    }

    const shards = await loadAllShards(ctx.agentDir, { logger: ctx.logger })
    if (shards.length === 0) {
      return resultToToolResult({ matches: [], truncatedAt: 0 })
    }

    const result = searchShards(shards, matcherOrError, { full, maxResults })
    return resultToToolResult(result)
  },
})

function buildMatcher(query: string, asRegex: boolean): Matcher | string {
  if (asRegex) {
    try {
      const regex = new RegExp(query, 'i')
      return (haystack) => regex.test(haystack)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `invalid regex: ${message}`
    }
  }

  const needle = query.toLowerCase()
  return (haystack) => haystack.toLowerCase().includes(needle)
}

function searchShards(
  shards: TopicShard[],
  matcher: Matcher,
  options: { full: boolean; maxResults: number },
): MemorySearchResult {
  const matches: MemorySearchMatch[] = []
  let truncatedAt: number | undefined

  for (const shard of shards) {
    const match = matchShard(shard, matcher, options.full)
    if (match === null) continue

    if (matches.length >= options.maxResults) {
      truncatedAt = options.maxResults
      break
    }
    matches.push(match)
  }

  return truncatedAt === undefined ? { matches } : { matches, truncatedAt }
}

function matchShard(shard: TopicShard, matcher: Matcher, full: boolean): MemorySearchMatch | null {
  const bodyLines = splitBodyLines(shard.body)
  const firstBodyLineIndex = bodyLines.findIndex((line) => matcher(line))

  const matched =
    matcher(shard.slug) ||
    matcher(shard.frontmatter.heading) ||
    (shard.frontmatter.tags?.some((tag) => matcher(tag)) ?? false) ||
    firstBodyLineIndex !== -1
  if (!matched) return null

  const match: MemorySearchMatch = {
    shardPath: shard.path,
    slug: shard.slug,
    heading: shard.frontmatter.heading,
    excerpt:
      firstBodyLineIndex === -1 ? fallbackExcerpt(shard, matcher) : excerptForLine(bodyLines, firstBodyLineIndex),
  }
  if (full) match.fullBody = shard.body
  return match
}

function splitBodyLines(body: string): string[] {
  const lines = body.split('\n')
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

function fallbackExcerpt(shard: TopicShard, matcher: Matcher): string {
  if (matcher(shard.frontmatter.heading)) return shard.frontmatter.heading
  if (matcher(shard.slug)) return shard.slug
  const matchedTag = shard.frontmatter.tags?.find((tag) => matcher(tag))
  return matchedTag ?? shard.frontmatter.heading
}

function excerptForLine(lines: string[], matchIndex: number): string {
  const start = Math.max(0, matchIndex - EXCERPT_CONTEXT_LINES)
  const end = Math.min(lines.length, matchIndex + EXCERPT_CONTEXT_LINES + 1)
  return lines.slice(start, end).join('\n')
}

function resultToToolResult(result: MemorySearchResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    details: result,
  }
}
