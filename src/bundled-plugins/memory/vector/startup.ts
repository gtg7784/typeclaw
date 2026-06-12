import { join } from 'node:path'

import { EMBEDDING_MODEL_ID, embed } from './embedder'
import { collectPassages, findMissingPassages, type EmbedFn } from './hybrid'
import { VectorStore } from './store'

export async function buildStartupVectorIndex(
  agentDir: string,
  embedFn: EmbedFn = embed,
): Promise<{ built: boolean; count: number }> {
  const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
  try {
    const passages = findMissingPassages(store, await collectPassages(agentDir))
    if (passages.length === 0) return { built: false, count: 0 }

    const embeddings = await embedFn(
      passages.map((passage) => passage.text),
      'passage',
    )

    let count = 0
    for (let i = 0; i < passages.length; i++) {
      const passage = passages[i]!
      const embedding = embeddings[i]
      if (embedding === undefined) continue

      store.upsert({
        id: passage.id,
        source: passage.source,
        key: passage.key,
        model: EMBEDDING_MODEL_ID,
        dims: embedding.length,
        embedding,
        contentHash: passage.contentHash,
      })
      count += 1
    }

    if (count === 0) return { built: false, count: 0 }

    // After a model/dtype switch, the prior variant's rows linger with a stale
    // `model` stamp (re-embedded passages upsert by id, but rows for the same id
    // already matched the new stamp, and orphans from removed content would not).
    // query() already excludes them, so this is hygiene — bound DB growth across
    // variant switches — not correctness. Runs only after a successful re-embed.
    store.deleteOtherModels(EMBEDDING_MODEL_ID)

    return { built: true, count }
  } finally {
    store.close()
  }
}
