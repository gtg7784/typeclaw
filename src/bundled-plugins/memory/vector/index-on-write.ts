import { fragmentContentHash } from '../fragment-parser'
import type { FragmentEvent } from '../stream-events'
import type { FragmentsAppendedContext } from '../stream-io'
import { embed, EMBEDDING_MODEL_ID } from './embedder'
import type { EmbedFn } from './hybrid'
import type { OpenVectorStore } from './store'

export function makeAppendHook(
  openStore: OpenVectorStore,
  embedFn: EmbedFn = embed,
): (fragments: FragmentEvent[], context: FragmentsAppendedContext) => Promise<void> {
  return async (fragments, context) => {
    const store = openStore()
    try {
      for (const fragment of fragments) {
        const key = `${context.date ?? fragment.ts.slice(0, 10)}#${fragment.id}`
        const id = `stream:${key}`
        const contentHash = fragmentContentHash(fragment)
        const existing = store.getByIds([id])[0]
        if (existing?.contentHash === contentHash && existing.model === EMBEDDING_MODEL_ID) continue

        const text = `${fragment.topic}\n${fragment.body}`
        const [embedding] = await embedFn([text], 'passage')
        if (embedding === undefined) continue
        store.upsert({
          id,
          source: 'stream',
          key,
          model: EMBEDDING_MODEL_ID,
          dims: embedding.length,
          embedding,
          contentHash,
        })
      }
    } finally {
      store.close()
    }
  }
}
