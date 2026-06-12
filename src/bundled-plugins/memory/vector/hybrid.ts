import { createHash } from 'node:crypto'

import { loadAllShards, type TopicShard } from '../load-shards'
import { buildParentLinks } from '../parent-link'
import { buildMatcher, searchAll, type MemorySearchMatch, type StreamMatch } from '../search-tool'
import type { StreamEvent } from '../stream-events'
import { readAllUndreamedStreamDays, type UndreamedStreamDay } from '../stream-io'
import { embed, EMBEDDING_MODEL_ID, type EmbedType } from './embedder'
import type { Passage } from './passages'
import { VectorStore, type VectorRow } from './store'

export { collectPassages, findMissingPassages, type Passage } from './passages'

const RRF_K = 60

export type HybridSearchResult = {
  source: 'topic' | 'stream'
  key: string
  heading: string
  excerpt: string
  rrfScore: number
}

export type EmbedFn = (texts: string[], type: EmbedType) => Promise<Float32Array[]>

export async function hybridSearch(
  query: string,
  store: VectorStore,
  agentDir: string,
  topK: number,
  embedFn: EmbedFn = embed,
): Promise<HybridSearchResult[]> {
  if (topK <= 0) return []

  const [shards, streamDays, queryEmbeddings] = await Promise.all([
    loadAllShards(agentDir),
    readAllUndreamedStreamDays(agentDir),
    embedFn([query], 'query'),
  ])

  const { parentSlugByFragmentId } = buildParentLinks(shards)
  const index = buildContentIndex(shards, streamDays)
  const vectorRows =
    queryEmbeddings[0] === undefined ? [] : store.query(queryEmbeddings[0], topK * 2, EMBEDDING_MODEL_ID)
  const keywordMatches = keywordLane(query, shards, streamDays, topK * 2)

  return fuseLanes(vectorRows, keywordMatches, index, parentSlugByFragmentId).slice(0, topK)
}

function keywordLane(
  query: string,
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  maxResults: number,
): MemorySearchMatch[] {
  const matcher = buildMatcher(query, false)
  if (typeof matcher === 'string') return []
  const result = searchAll(shards, streamDays, matcher, { full: false, maxResults })
  return 'matches' in result ? result.matches : []
}

// Parent-child fusion. Each lane hit scores its node by RRF rank, then nodes
// collapse to their parent topic via the citation link: a matched fragment
// contributes to the topic that cites it, never as a standalone result. An
// undreamed fragment (no citing topic yet) resolves to itself, preserving the
// freshness window. Collapsed parents take the MAX of their members' scores,
// not the sum — sum would over-rank often-revised topics purely for having more
// historical citations to match (PARADE: max beats sum for concentrated relevance).
function fuseLanes(
  vectorRows: VectorRow[],
  keywordMatches: MemorySearchMatch[],
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugByFragmentId: Map<string, string>,
): HybridSearchResult[] {
  const fused = new Map<string, HybridSearchResult>()

  for (let i = 0; i < vectorRows.length; i++) {
    const row = vectorRows[i]!
    addScore(fused, index, row.source, row.key, 1 / (RRF_K + i + 1), parentSlugByFragmentId)
  }

  for (let i = 0; i < keywordMatches.length; i++) {
    const match = keywordMatches[i]!
    addScore(fused, index, match.source, matchKey(match), 1 / (RRF_K + i + 1), parentSlugByFragmentId)
  }

  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.key.localeCompare(b.key))
}

function addScore(
  fused: Map<string, HybridSearchResult>,
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  source: 'topic' | 'stream',
  nodeKey: string,
  score: number,
  parentSlugByFragmentId: Map<string, string>,
): void {
  const resolved = resolveToParent(source, nodeKey, index, parentSlugByFragmentId)
  if (resolved === null) return
  const { fusedKey, content } = resolved

  const existing = fused.get(fusedKey)
  if (existing !== undefined) {
    existing.rrfScore = Math.max(existing.rrfScore, score)
    return
  }
  fused.set(fusedKey, { ...content, rrfScore: score })
}

function resolveToParent(
  source: 'topic' | 'stream',
  nodeKey: string,
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugByFragmentId: Map<string, string>,
): { fusedKey: string; content: Omit<HybridSearchResult, 'rrfScore'> } | null {
  if (source === 'stream') {
    const fragmentId = fragmentIdFromKey(nodeKey)
    const parentSlug = fragmentId === null ? undefined : parentSlugByFragmentId.get(fragmentId)
    if (parentSlug !== undefined) {
      const topic = index.get(laneKey('topic', parentSlug))
      if (topic !== undefined) return { fusedKey: laneKey('topic', parentSlug), content: topic }
    }
  }
  const content = index.get(laneKey(source, nodeKey))
  return content === undefined ? null : { fusedKey: laneKey(source, nodeKey), content }
}

function fragmentIdFromKey(streamKey: string): string | null {
  const hashIndex = streamKey.indexOf('#')
  if (hashIndex === -1) return null
  const id = streamKey.slice(hashIndex + 1)
  return id.startsWith('legacy-') ? null : id
}

function buildContentIndex(
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
): Map<string, Omit<HybridSearchResult, 'rrfScore'>> {
  const index = new Map<string, Omit<HybridSearchResult, 'rrfScore'>>()

  for (const shard of shards) {
    index.set(laneKey('topic', shard.slug), {
      source: 'topic',
      key: shard.slug,
      heading: shard.frontmatter.heading,
      excerpt: excerpt(shard.body, shard.frontmatter.heading),
    })
  }

  for (const day of streamDays) {
    for (const event of day.events) {
      const item = streamIndexItem(day, event)
      if (item !== null) index.set(laneKey('stream', item.key), item)
    }
  }

  return index
}

function streamIndexItem(day: UndreamedStreamDay, event: StreamEvent): Omit<HybridSearchResult, 'rrfScore'> | null {
  if (event.type === 'watermark') return null
  if (event.type === 'fragment') {
    return {
      source: 'stream',
      key: `${day.date}#${event.id}`,
      heading: event.topic,
      excerpt: excerpt(event.body, event.topic),
    }
  }
  return {
    source: 'stream',
    key: `${day.date}#legacy-${hashContent(event.text).slice(0, 12)}`,
    heading: '[legacy prose from pre-shard migration]',
    excerpt: excerpt(event.text, '[legacy prose from pre-shard migration]'),
  }
}

function matchKey(match: MemorySearchMatch): string {
  if (match.source === 'topic') return match.slug
  return streamMatchKey(match)
}

function streamMatchKey(match: StreamMatch): string {
  if (match.eventId !== undefined) return match.eventId.replace(/^streams\//, '')
  return `${match.date}#legacy-${hashContent(match.excerpt).slice(0, 12)}`
}

function laneKey(source: 'topic' | 'stream', key: string): string {
  return `${source}:${key}`
}

function excerpt(body: string, fallback: string): string {
  const trimmed = body.trim()
  if (trimmed.length === 0) return fallback
  return trimmed.split('\n').slice(0, 7).join('\n')
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
