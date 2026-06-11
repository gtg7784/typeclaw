import { fragmentContentHash } from '../fragment-parser'
import type { FragmentEvent } from '../stream-events'
import { embed, MODEL_NAME } from './embedder'
import type { EmbedFn } from './hybrid'
import type { VectorStore } from './store'

export function makeAppendHook(
  store: VectorStore,
  embedFn: EmbedFn = embed,
): (fragments: FragmentEvent[]) => Promise<void> {
  return async (fragments) => {
    for (const fragment of fragments) {
      const key = streamKey(fragment)
      const id = `stream:${key}`
      const contentHash = fragmentContentHash(fragment)
      const existing = store.getByIds([id])[0]
      if (existing?.contentHash === contentHash && existing.model === MODEL_NAME) continue

      const text = `${fragment.topic}\n${fragment.body}`
      const [embedding] = await embedFn([text], 'passage')
      if (embedding === undefined) continue
      store.upsert({
        id,
        source: 'stream',
        key,
        model: MODEL_NAME,
        dims: embedding.length,
        embedding,
        contentHash,
      })
    }
  }
}

function streamKey(fragment: FragmentEvent): string {
  return `${fragment.ts.slice(0, 10)}#${fragment.id}`
}
