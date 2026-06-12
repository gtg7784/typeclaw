import { createHash } from 'node:crypto'

import { loadAllShards, type TopicShard } from '../load-shards'
import { buildParentLinks } from '../parent-link'
import {
  buildMatcher,
  distinctTokens,
  hasNonAscii,
  searchAll,
  searchAllRanked,
  type MemorySearchMatch,
  type StreamMatch,
} from '../search-tool'
import type { StreamEvent } from '../stream-events'
import { readAllUndreamedStreamDays, type UndreamedStreamDay } from '../stream-io'
import { embed, EMBEDDING_MODEL_ID, type EmbedType } from './embedder'
import type { Passage } from './passages'
import { clearsBaseline, gateRelevance, streamAdmissionBaseline } from './relevance-gate'
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

  const { parentSlugsByFragmentId, supersededFragmentIds } = buildParentLinks(shards)
  const index = buildContentIndex(shards, streamDays, supersededFragmentIds)
  const vectorRows = queryEmbeddings[0] === undefined ? [] : gatedVectorLane(queryEmbeddings[0], store, topK)
  const keywordMatches = keywordLane(query, shards, streamDays, topK * 2)

  return fuseLanes(vectorRows, keywordMatches, index, parentSlugsByFragmentId).slice(0, topK)
}

// The vector lane, gated by per-query relevance. Both row kinds are judged
// against ONE query-local no-match band, derived from the TOPIC score
// distribution alone (topics are the only stable-enough corpus to estimate the
// ambient band; sparse streams consume the band but never define it, so a
// nearest-neighbour cluster of fragments can't move the bar).
//
//   - Topic rows: the gate keeps the knee above the band, or empties the topic
//     partition entirely when no topic clears it.
//   - Stream rows: admitted one-by-one only when they clear the SAME band by
//     the shared margin. A genuine fresh fragment (well above the band) survives
//     the freshness window; an irrelevant in-band neighbour is dropped, so a
//     no-match query can't leak closest-neighbours-regardless through streams.
//
// Topic suppression uses the floor-gated verdict (gateRelevance): below the
// floor topics pass ungated, since a tiny index can't form a reliable band and
// a false negative is cheaper than suppressing the only memory. Stream
// admission uses streamAdmissionBaseline, which tolerates a below-floor topic
// set — even a few topics give the contrast a vector-only fragment match needs,
// and it returns null (dropping uncorroborated streams) only when NO topics
// exist at all. A lexically-corroborated fragment still reaches RRF via the
// separate keyword lane. An empty merged lane composes with RRF exactly like a
// lane that found nothing, so a genuine keyword hit survives a full no-match.
function gatedVectorLane(queryEmbedding: Float32Array, store: VectorStore, topK: number): VectorRow[] {
  const scored = store.queryScored(queryEmbedding, EMBEDDING_MODEL_ID)
  const topicRows = scored.filter(({ row }) => row.source === 'topic')
  const streamRows = scored.filter(({ row }) => row.source === 'stream')

  const topicScores = topicRows.map(({ score }) => score)
  const keptTopics = topicRows.slice(0, gateRelevance(topicScores, topK * 2))
  const streamBaseline = streamAdmissionBaseline(topicScores)
  const keptStreams = streamRows.filter(({ score }) => clearsBaseline(score, streamBaseline)).slice(0, topK * 2)

  return [...keptTopics, ...keptStreams].sort((a, b) => b.score - a.score).map(({ row }) => row)
}

// Phrase-first, then token-OR fallback (mirrors `memory_search`). `hybridSearch`'s
// query is always the whole user prompt, which never appears verbatim in a shard,
// so a phrase-only lane returns nothing every real turn and RRF degenerates to the
// vector lane alone. The `searchAllRanked` fallback also gives RRF a
// matched-token-count rank (truncated after ranking) instead of alphabetical order.
function keywordLane(
  query: string,
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  maxResults: number,
): MemorySearchMatch[] {
  const matcher = buildMatcher(query, false)
  if (typeof matcher === 'string') return []
  const phrase = searchAll(shards, streamDays, matcher, { full: false, maxResults })
  const phraseMatches = 'matches' in phrase ? phrase.matches : []
  if (phraseMatches.length > 0) return phraseMatches

  const tokens = distinctHybridContentTokens(query)
  if (tokens.length === 0) return []
  if (tokens.length === 1 && tokens[0] === query.trim().toLowerCase()) return []
  const ranked = searchAllRanked(shards, streamDays, tokens, {
    full: false,
    maxResults,
    tokenMatchMode: 'ascii-boundary',
  })
  return 'matches' in ranked ? ranked.matches : []
}

// Stopwords are judged ONLY against a token's ASCII-alpha core (below), so this
// set is intentionally English-only — non-ASCII tokens never reach it.
const HYBRID_PROMPT_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'i',
  'me',
  'my',
  'mine',
  'you',
  'your',
  'yours',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'it',
  'its',
  'we',
  'us',
  'our',
  'ours',
  'they',
  'them',
  'their',
  'theirs',
  'this',
  'that',
  'these',
  'those',
  'here',
  'there',
  'what',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'why',
  'how',
  'which',
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'doing',
  'have',
  'has',
  'had',
  'having',
  'can',
  'could',
  'should',
  'would',
  'will',
  'may',
  'might',
  'must',
  'about',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'onto',
  'to',
  'with',
  'without',
  'over',
  'under',
  'after',
  'before',
  'between',
  'up',
  'down',
  'out',
  'off',
  'say',
  'said',
  'thing',
  'things',
  'stuff',
])

// The hybrid lane's query is a whole user prompt, so its tokens include
// function words ('what', 'we', 'the', 'about'). Token-OR matching on those
// alone would make the keyword lane non-empty for a low-information prompt and,
// when the vector lane is gated out, inject arbitrary memory instead of no
// result. The tool path's `distinctTokens` stays untouched — there the query is
// a deliberate agent search, not a sentence. Stopwords are judged ONLY on a
// token's ASCII-alpha core, so non-ASCII tokens ('홍길동'), numerics ('#651'),
// and short content words ('pr', 'ci', 'go') all survive; no length filter,
// which would wrongly drop CJK and short content.
function distinctHybridContentTokens(query: string): string[] {
  return distinctTokens(query).filter((token) => {
    const core = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    if (core.length === 0) return hasNonAscii(token)
    if (!/^[a-z]+$/.test(core)) return true
    return !HYBRID_PROMPT_STOPWORDS.has(core)
  })
}

// Reciprocal Rank Fusion across two rankers (vector + keyword). Each lane is
// collapsed to per-parent scores INDEPENDENTLY (MAX over a parent's children
// within that lane), then the two lanes' per-parent scores are SUMMED. The two
// reductions are different on purpose:
//
//   - WITHIN a lane, a topic's children (the fragments citing it) collapse by
//     MAX — summing would over-rank often-revised topics purely for having more
//     historical citations to match (PARADE: max beats sum for concentrated
//     relevance).
//   - ACROSS lanes, the per-parent contributions SUM — cross-ranker agreement
//     is the entire signal RRF exists to capture. A topic found by BOTH the
//     vector and the keyword lane must outrank one found by a single lane, so
//     its score is 1/(k+rankVector) + 1/(k+rankKeyword). Collapsing both lanes
//     into one map and taking MAX (the previous behavior) discarded that
//     agreement, leaving every result carrying a single lane's reciprocal rank.
function fuseLanes(
  vectorRows: VectorRow[],
  keywordMatches: MemorySearchMatch[],
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugsByFragmentId: Map<string, Set<string>>,
): HybridSearchResult[] {
  const vectorLane = collapseLane(
    vectorRows.map((row, i) => ({ source: row.source, key: row.key, score: 1 / (RRF_K + i + 1) })),
    index,
    parentSlugsByFragmentId,
  )
  const keywordLane = collapseLane(
    keywordMatches.map((match, i) => ({ source: match.source, key: matchKey(match), score: 1 / (RRF_K + i + 1) })),
    index,
    parentSlugsByFragmentId,
  )

  const fused = new Map<string, HybridSearchResult>()
  for (const lane of [vectorLane, keywordLane]) {
    for (const [fusedKey, { content, score }] of lane) {
      const existing = fused.get(fusedKey)
      if (existing !== undefined) existing.rrfScore += score
      else fused.set(fusedKey, { ...content, rrfScore: score })
    }
  }

  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.key.localeCompare(b.key))
}

type LaneHit = { source: 'topic' | 'stream'; key: string; score: number }
type LaneEntry = { content: Omit<HybridSearchResult, 'rrfScore'>; score: number }

// Returns one lane's per-parent scores so the caller can SUM across lanes;
// folding straight into a shared map would force a cross-lane MAX instead.
function collapseLane(
  hits: LaneHit[],
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugsByFragmentId: Map<string, Set<string>>,
): Map<string, LaneEntry> {
  const lane = new Map<string, LaneEntry>()
  for (const hit of hits) {
    for (const { fusedKey, content } of resolveToParents(hit.source, hit.key, index, parentSlugsByFragmentId)) {
      const existing = lane.get(fusedKey)
      if (existing !== undefined) existing.score = Math.max(existing.score, hit.score)
      else lane.set(fusedKey, { content, score: hit.score })
    }
  }
  return lane
}

// A matched fragment collapses to EVERY topic that cites it (a fragment can back
// more than one belief), so it contributes its score to each parent. An
// undreamed fragment with no citing topic resolves to itself.
function resolveToParents(
  source: 'topic' | 'stream',
  nodeKey: string,
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugsByFragmentId: Map<string, Set<string>>,
): Array<{ fusedKey: string; content: Omit<HybridSearchResult, 'rrfScore'> }> {
  if (source === 'stream') {
    const fragmentId = fragmentIdFromKey(nodeKey)
    const parentSlugs = fragmentId === null ? undefined : parentSlugsByFragmentId.get(fragmentId)
    if (parentSlugs !== undefined && parentSlugs.size > 0) {
      const parents: Array<{ fusedKey: string; content: Omit<HybridSearchResult, 'rrfScore'> }> = []
      for (const parentSlug of parentSlugs) {
        const topic = index.get(laneKey('topic', parentSlug))
        if (topic !== undefined) parents.push({ fusedKey: laneKey('topic', parentSlug), content: topic })
      }
      if (parents.length > 0) return parents
    }
  }
  const content = index.get(laneKey(source, nodeKey))
  return content === undefined ? [] : [{ fusedKey: laneKey(source, nodeKey), content }]
}

function fragmentIdFromKey(streamKey: string): string | null {
  const hashIndex = streamKey.indexOf('#')
  if (hashIndex === -1) return null
  const id = streamKey.slice(hashIndex + 1)
  return id.startsWith('legacy-') ? null : id
}

// Superseded fragments are kept out of the content index entirely, so both
// lanes drop them: the keyword lane can match a superseded body, but resolving
// it finds no active parent link and then no `stream` fallback here, so the
// stale fragment never surfaces as a standalone result (mirrors the passage-set
// exclusion that keeps superseded fragments out of the vector lane).
function buildContentIndex(
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  supersededFragmentIds: Set<string>,
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
      const item = streamIndexItem(day, event, supersededFragmentIds)
      if (item !== null) index.set(laneKey('stream', item.key), item)
    }
  }

  return index
}

function streamIndexItem(
  day: UndreamedStreamDay,
  event: StreamEvent,
  supersededFragmentIds: Set<string>,
): Omit<HybridSearchResult, 'rrfScore'> | null {
  if (event.type === 'watermark') return null
  if (event.type === 'fragment') {
    if (supersededFragmentIds.has(event.id)) return null
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
