import { z } from 'zod'

import { defineTool } from '@/plugin'

import { loadAllShards, type TopicShard } from './load-shards'
import type { FragmentEvent, LegacyProseEvent, StreamEvent } from './stream-events'
import { readAllUndreamedStreamDays, type UndreamedStreamDay } from './stream-io'

const DEFAULT_MAX_RESULTS = 10
const EXCERPT_CONTEXT_LINES = 3

type TopicMatch = {
  source: 'topic'
  shardPath: string
  slug: string
  heading: string
  excerpt: string
  fullBody?: string
}

type StreamMatch = {
  source: 'stream'
  streamPath: string
  date: string
  eventId?: string
  topic: string
  excerpt: string
  fullBody?: string
}

type MemorySearchMatch = TopicMatch | StreamMatch

type MemorySearchResult = { matches: MemorySearchMatch[]; truncatedAt?: number } | { error: string }

type Matcher = (haystack: string) => boolean

export const memorySearchTool = defineTool({
  description:
    'Search the agent\'s long-term memory. Covers both topic shards under memory/topics/ (consolidated facts) and undreamed daily-stream events under memory/streams/ (recent fragments not yet folded into shards). Case-insensitive substring by default: tries the whole query as one phrase first, and if that finds nothing, falls back to OR-matching the individual words (ranked by how many words each hit contains) — so a multi-word query still returns results even when no entry contains the exact phrase. asRegex=true treats query as a JavaScript regex (no word fallback). Returns matches discriminated by `source: "topic" | "stream"`, each with line-context excerpts; full=true includes complete bodies. Topic matches come first (alphabetical by slug), then stream matches (newest day first).',
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

    const [shards, streamDays] = await Promise.all([
      loadAllShards(ctx.agentDir, { logger: ctx.logger }),
      readAllUndreamedStreamDays(ctx.agentDir),
    ])
    if (shards.length === 0 && streamDays.length === 0) {
      return resultToToolResult({ matches: [], truncatedAt: 0 })
    }

    const result = searchAll(shards, streamDays, matcherOrError, { full, maxResults })
    if ('matches' in result && result.matches.length === 0) {
      const fallback = tokenFallback(query, asRegex, shards, streamDays, { full, maxResults })
      if (fallback !== null) return resultToToolResult(fallback)
    }
    return resultToToolResult(result)
  },
})

// Phrase-first/token-fallback: the descriptive multi-word queries the
// retrieval subagent issues rarely appear verbatim in any body, so a
// whole-phrase substring search returns nothing while every component word is
// present. When the phrase search comes up empty, split on whitespace and
// OR-match the distinct tokens, ranking each hit by how many tokens it
// matched (richer matches first) with the natural topic-first/newest-stream
// order as the stable tiebreak. Returns null when tokenizing cannot widen the
// search: regex mode (whitespace is intentional pattern syntax), or a token
// set that is identical to the phrase already tried (a single clean token, so
// the phrase search already covered it).
function tokenFallback(
  query: string,
  asRegex: boolean,
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  options: { full: boolean; maxResults: number },
): MemorySearchResult | null {
  if (asRegex) return null
  const tokens = distinctTokens(query)
  if (tokens.length === 0) return null
  if (tokens.length === 1 && tokens[0] === query.trim().toLowerCase()) return null
  return searchAllRanked(shards, streamDays, tokens, options)
}

function distinctTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    ),
  ]
}

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

// Result-ordering contract: topic shards first (alphabetical by slug, the
// order `loadAllShards` returns), then stream days (newest first). Truncation
// cuts from the tail of this concatenation — stream matches are sacrificed
// before topic matches when `maxResults` is exhausted. The agent reading
// results in this order sees long-term consolidated truth before recent
// ephemeral fragments, which mirrors the injection-side rendering order.
function searchAll(
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  matcher: Matcher,
  options: { full: boolean; maxResults: number },
): MemorySearchResult {
  const matches: MemorySearchMatch[] = []
  let truncatedAt: number | undefined

  const push = (match: MemorySearchMatch): boolean => {
    if (matches.length >= options.maxResults) {
      truncatedAt = options.maxResults
      return false
    }
    matches.push(match)
    return true
  }

  for (const shard of shards) {
    const match = matchShard(shard, matcher, options.full)
    if (match === null) continue
    if (!push(match)) return { matches, truncatedAt: truncatedAt! }
  }

  for (let i = streamDays.length - 1; i >= 0; i--) {
    const day = streamDays[i]!
    for (const event of day.events) {
      const match = matchStreamEvent(day, event, matcher, options.full)
      if (match === null) continue
      if (!push(match)) return { matches, truncatedAt: truncatedAt! }
    }
  }

  return truncatedAt === undefined ? { matches } : { matches, truncatedAt }
}

// Token-OR variant of searchAll. Builds each match with an any-token matcher
// (so a hit requires only one token and the excerpt anchors on the first line
// matching any token), then scores it by how many distinct tokens appear in
// its full searchable text. Results sort by score descending; ties keep the
// natural enumeration order (topics first in loadAllShards order, then stream
// days newest-first), so the established ordering contract holds within each
// score band. maxResults truncation is applied last, after ranking.
function searchAllRanked(
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  tokens: string[],
  options: { full: boolean; maxResults: number },
): MemorySearchResult {
  const anyToken: Matcher = (haystack) => {
    const lower = haystack.toLowerCase()
    return tokens.some((t) => lower.includes(t))
  }
  const scoreOf = (text: string): number => {
    const lower = text.toLowerCase()
    return tokens.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0)
  }

  const scored: Array<{ match: MemorySearchMatch; score: number; order: number }> = []
  let order = 0

  for (const shard of shards) {
    const match = matchShard(shard, anyToken, options.full)
    if (match === null) continue
    scored.push({ match, score: scoreOf(shardSearchText(shard)), order: order++ })
  }

  for (let i = streamDays.length - 1; i >= 0; i--) {
    const day = streamDays[i]!
    for (const event of day.events) {
      const match = matchStreamEvent(day, event, anyToken, options.full)
      if (match === null) continue
      scored.push({ match, score: scoreOf(eventSearchText(event)), order: order++ })
    }
  }

  scored.sort((a, b) => b.score - a.score || a.order - b.order)

  if (scored.length > options.maxResults) {
    return { matches: scored.slice(0, options.maxResults).map((s) => s.match), truncatedAt: options.maxResults }
  }
  return { matches: scored.map((s) => s.match) }
}

function shardSearchText(shard: TopicShard): string {
  return [shard.slug, shard.frontmatter.heading, ...(shard.frontmatter.tags ?? []), shard.body].join('\n')
}

function eventSearchText(event: StreamEvent): string {
  if (event.type === 'fragment') return `${event.topic}\n${event.body}`
  if (event.type === 'legacy_prose') return event.text
  return ''
}

function matchShard(shard: TopicShard, matcher: Matcher, full: boolean): TopicMatch | null {
  const bodyLines = splitBodyLines(shard.body)
  const firstBodyLineIndex = bodyLines.findIndex((line) => matcher(line))

  const matched =
    matcher(shard.slug) ||
    matcher(shard.frontmatter.heading) ||
    (shard.frontmatter.tags?.some((tag) => matcher(tag)) ?? false) ||
    firstBodyLineIndex !== -1
  if (!matched) return null

  const match: TopicMatch = {
    source: 'topic',
    shardPath: shard.path,
    slug: shard.slug,
    heading: shard.frontmatter.heading,
    excerpt:
      firstBodyLineIndex === -1 ? fallbackExcerpt(shard, matcher) : excerptForLine(bodyLines, firstBodyLineIndex),
  }
  if (full) match.fullBody = shard.body
  return match
}

// Stream-event matcher. `fragment` events expose `topic` + `body` for search;
// `legacy_prose` exposes `text` (no id, no topic). `watermark` events carry
// no human content and are skipped — they only mark dreaming progress.
//
// Fragment matches set `eventId` to the canonical citation format
// `streams/yyyy-MM-dd#<id>` so the agent can paste search hits straight into
// shard citations. Legacy prose has no fragment id and therefore omits
// `eventId` — `parseCitations` would reject any value we synthesised, so we
// leave the field absent to make the asymmetry visible to the agent.
function matchStreamEvent(
  day: UndreamedStreamDay,
  event: StreamEvent,
  matcher: Matcher,
  full: boolean,
): StreamMatch | null {
  if (event.type === 'watermark') return null
  if (event.type === 'fragment') return matchFragmentEvent(day, event, matcher, full)
  return matchLegacyProseEvent(day, event, matcher, full)
}

function matchFragmentEvent(
  day: UndreamedStreamDay,
  event: FragmentEvent,
  matcher: Matcher,
  full: boolean,
): StreamMatch | null {
  const bodyLines = splitBodyLines(event.body)
  const firstBodyLineIndex = bodyLines.findIndex((line) => matcher(line))
  const matched = matcher(event.topic) || firstBodyLineIndex !== -1
  if (!matched) return null

  const match: StreamMatch = {
    source: 'stream',
    streamPath: day.path,
    date: day.date,
    eventId: `streams/${day.date}#${event.id}`,
    topic: event.topic,
    excerpt: firstBodyLineIndex === -1 ? event.topic : excerptForLine(bodyLines, firstBodyLineIndex),
  }
  if (full) match.fullBody = event.body
  return match
}

function matchLegacyProseEvent(
  day: UndreamedStreamDay,
  event: LegacyProseEvent,
  matcher: Matcher,
  full: boolean,
): StreamMatch | null {
  const lines = splitBodyLines(event.text)
  const firstLineIndex = lines.findIndex((line) => matcher(line))
  if (firstLineIndex === -1) return null

  const match: StreamMatch = {
    source: 'stream',
    streamPath: day.path,
    date: day.date,
    topic: '[legacy prose from pre-shard migration]',
    excerpt: excerptForLine(lines, firstLineIndex),
  }
  if (full) match.fullBody = event.text
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
