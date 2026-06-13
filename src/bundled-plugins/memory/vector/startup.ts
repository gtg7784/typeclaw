import { join } from 'node:path'

import { EMBEDDING_MODEL_ID, embed } from './embedder'
import { collectPassages, findMissingPassages, type EmbedFn } from './hybrid'
import { VectorStore } from './store'

export async function buildStartupVectorIndex(
  agentDir: string,
  embedFn: EmbedFn = embed,
  referencesEnabled = false,
): Promise<{ built: boolean; pruned: number; count: number }> {
  const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
  try {
    const wanted = await collectPassages(agentDir, referencesEnabled)

    // Prune current-model rows whose id left the desired passage set (deleted
    // topics, dreamed-then-GC'd fragments, and — load-bearing here — fragments
    // dreaming marked superseded). Without this, superseded `stream:*` rows stay
    // in the table and can outrank active rows by raw cosine, consuming the
    // finite `topK * 2` candidates before parent-child fusion ever sees them.
    const pruned = pruneStaleRows(store, wanted)

    const passages = findMissingPassages(store, wanted)
    if (passages.length === 0) return { built: false, pruned, count: 0 }

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

    if (count === 0) return { built: false, pruned, count: 0 }

    // After a model/dtype switch, the prior variant's rows linger with a stale
    // `model` stamp (re-embedded passages upsert by id, but rows for the same id
    // already matched the new stamp, and orphans from removed content would not).
    // query() already excludes them, so this is hygiene — bound DB growth across
    // variant switches — not correctness. Runs only after a successful re-embed.
    store.deleteOtherModels(EMBEDDING_MODEL_ID)

    return { built: true, pruned, count }
  } finally {
    store.close()
  }
}

function pruneStaleRows(store: VectorStore, wanted: Awaited<ReturnType<typeof collectPassages>>): number {
  const wantedIds = new Set(wanted.map((passage) => passage.id))
  const stale = store
    .getAllMeta()
    .filter((row) => row.model === EMBEDDING_MODEL_ID && !wantedIds.has(row.id))
    .map((row) => row.id)
  if (stale.length > 0) store.deleteMany(stale)
  return stale.length
}
