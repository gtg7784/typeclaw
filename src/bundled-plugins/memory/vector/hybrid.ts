import { createHash } from 'node:crypto'

import { withGitLock } from '@/git/mutex'

import { loadAllShards, type TopicShard } from '../load-shards'
import { buildMatcher, searchAll, type MemorySearchMatch, type StreamMatch } from '../search-tool'
import type { StreamEvent } from '../stream-events'
import { readAllUndreamedStreamDays, type UndreamedStreamDay } from '../stream-io'
import { embed, MODEL_NAME, type EmbedType } from './embedder'
import { VectorStore, type VectorRow } from './store'

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

  const index = buildContentIndex(shards, streamDays)
  const vectorRows = queryEmbeddings[0] === undefined ? [] : store.query(queryEmbeddings[0], topK * 2)
  const keywordMatches = keywordLane(query, shards, streamDays, topK * 2)

  return fuseLanes(vectorRows, keywordMatches, index).slice(0, topK)
}

export async function buildLazyIndex(store: VectorStore, agentDir: string, embedFn: EmbedFn = embed): Promise<void> {
  if (store.getAll().length > 0) return

  await withGitLock(agentDir, async () => {
    if (store.getAll().length > 0) return

    const [shards, streamDays] = await Promise.all([loadAllShards(agentDir), readAllUndreamedStreamDays(agentDir)])
    const passages = buildPassages(shards, streamDays)
    const embeddings = await embedFn(
      passages.map((passage) => passage.text),
      'passage',
    )

    for (let i = 0; i < passages.length; i++) {
      const passage = passages[i]!
      const embedding = embeddings[i]
      if (embedding === undefined) continue
      store.upsert({
        id: passage.id,
        source: passage.source,
        key: passage.key,
        model: MODEL_NAME,
        dims: embedding.length,
        embedding,
        contentHash: hashContent(passage.text),
      })
    }
  })
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

function fuseLanes(
  vectorRows: VectorRow[],
  keywordMatches: MemorySearchMatch[],
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
): HybridSearchResult[] {
  const fused = new Map<string, HybridSearchResult>()

  for (let i = 0; i < vectorRows.length; i++) {
    const row = vectorRows[i]!
    addScore(fused, index, laneKey(row.source, row.key), 1 / (RRF_K + i + 1))
  }

  for (let i = 0; i < keywordMatches.length; i++) {
    const match = keywordMatches[i]!
    addScore(fused, index, laneKey(match.source, matchKey(match)), 1 / (RRF_K + i + 1))
  }

  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.key.localeCompare(b.key))
}

function addScore(
  fused: Map<string, HybridSearchResult>,
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  key: string,
  score: number,
): void {
  const existing = fused.get(key)
  if (existing !== undefined) {
    existing.rrfScore += score
    return
  }

  const content = index.get(key)
  if (content === undefined) return
  fused.set(key, { ...content, rrfScore: score })
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

function buildPassages(shards: TopicShard[], streamDays: UndreamedStreamDay[]): Passage[] {
  return [
    ...shards.map(
      (shard): Passage => ({
        id: `topic:${shard.slug}`,
        source: 'topic',
        key: shard.slug,
        text: `${shard.frontmatter.heading}\n${shard.body}`,
      }),
    ),
    ...streamDays.flatMap((day) =>
      day.events.flatMap((event): Passage[] => {
        if (event.type === 'watermark') return []
        if (event.type === 'fragment') {
          const key = `${day.date}#${event.id}`
          return [{ id: `stream:${key}`, source: 'stream', key, text: `${event.topic}\n${event.body}` }]
        }
        const key = `${day.date}#legacy-${hashContent(event.text).slice(0, 12)}`
        return [{ id: `stream:${key}`, source: 'stream', key, text: event.text }]
      }),
    ),
  ]
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

type Passage = {
  id: string
  source: 'topic' | 'stream'
  key: string
  text: string
}
