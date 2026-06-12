import { createHash } from 'node:crypto'

import { stripCitationLines } from '../citations'
import { fragmentContentHash } from '../fragment-parser'
import { loadAllShards, type TopicShard } from '../load-shards'
import { buildParentLinks } from '../parent-link'
import { readAllUndreamedStreamDays, type UndreamedStreamDay } from '../stream-io'
import { EMBEDDING_MODEL_ID } from './embedder'
import type { VectorStore } from './store'

export type Passage = {
  id: string
  source: 'topic' | 'stream'
  key: string
  text: string
  contentHash: string
}

// The single source of truth for a topic's embedded text + freshness hash, so the
// startup index build and dreaming's per-pass refresh stay byte-identical. The
// contentHash covers the EMBEDDED text (not the raw body): changing how the text
// is derived must invalidate every existing topic row, but `fragmentContentHash`
// over the unchanged raw body would not — `findMissingPassages` would skip them.
export function topicPassage(slug: string, heading: string, body: string): Passage {
  const text = `${heading}\n${stripCitationLines(body)}`
  return { id: `topic:${slug}`, source: 'topic', key: slug, text, contentHash: hashContent(text) }
}

export async function collectPassages(agentDir: string): Promise<Passage[]> {
  const [shards, streamDays] = await Promise.all([loadAllShards(agentDir), readAllUndreamedStreamDays(agentDir)])
  return buildPassages(shards, streamDays)
}

export function findMissingPassages(store: VectorStore, passages: Passage[]): Passage[] {
  const existing = new Map(store.getAllMeta().map((row) => [row.id, row]))
  return passages.filter((passage) => {
    const row = existing.get(passage.id)
    return row === undefined || row.model !== EMBEDDING_MODEL_ID || row.contentHash !== passage.contentHash
  })
}

function buildPassages(shards: TopicShard[], streamDays: UndreamedStreamDay[]): Passage[] {
  const { supersededFragmentIds } = buildParentLinks(shards)
  return [
    ...shards.map((shard): Passage => topicPassage(shard.slug, shard.frontmatter.heading, shard.body)),
    ...streamDays.flatMap((day) =>
      day.events.flatMap((event): Passage[] => {
        if (event.type === 'watermark') return []
        if (event.type === 'fragment') {
          // Superseded fragments stay cited for GC/history but are not embedded:
          // they must never be a retrieval hook for a belief they no longer back.
          if (supersededFragmentIds.has(event.id)) return []
          const key = `${day.date}#${event.id}`
          return [
            {
              id: `stream:${key}`,
              source: 'stream',
              key,
              text: `${event.topic}\n${event.body}`,
              contentHash: fragmentContentHash(event),
            },
          ]
        }
        const key = `${day.date}#legacy-${hashContent(event.text).slice(0, 12)}`
        return [{ id: `stream:${key}`, source: 'stream', key, text: event.text, contentHash: hashContent(event.text) }]
      }),
    ),
  ]
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
