import { createHash } from 'node:crypto'

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
    ...shards.map(
      (shard): Passage => ({
        id: `topic:${shard.slug}`,
        source: 'topic',
        key: shard.slug,
        text: `${shard.frontmatter.heading}\n${shard.body}`,
        contentHash: fragmentContentHash({ topic: shard.frontmatter.heading, body: shard.body }),
      }),
    ),
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
