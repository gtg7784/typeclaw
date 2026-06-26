import { embed, EMBEDDING_MODEL_ID } from './embedder'
import type { EmbedFn } from './hybrid'
import { referencePassagesForOne } from './passages'
import type { OpenVectorStore } from './store'

export type ReferenceStoredContext = { slug: string; body: string; demoted?: boolean }

// Embeds a freshly stored reference into the vector index immediately, mirroring
// the stream-fragment on-write hook (`makeAppendHook`). Without this, a reference
// is only embedded at the next startup index build, so it is vector-unretrievable
// for the rest of the container's uptime. Chunks are derived by the same
// `referencePassagesForOne` the startup build uses, so the rows agree.
//
// Re-storing a slug with a shorter body produces fewer chunks; the stale
// higher-index `reference:<slug>#N` rows from the prior body must be pruned or
// they would resurface as orphaned retrieval hooks for content that no longer
// exists. We compute the wanted id set, upsert changed chunks, and delete any
// existing row for this slug that is not wanted.
export function makeReferenceStoredHook(
  openStore: OpenVectorStore,
  embedFn: EmbedFn = embed,
): (context: ReferenceStoredContext) => Promise<void> {
  return async ({ slug, body, demoted }) => {
    const store = openStore()
    try {
      const passages = referencePassagesForOne(slug, body, demoted)
      const wantedIds = new Set(passages.map((passage) => passage.id))

      const prefix = `reference:${slug}#`
      const staleIds = store
        .getAllMeta()
        .flatMap((row) => (row.id.startsWith(prefix) && !wantedIds.has(row.id) ? [row.id] : []))
      if (staleIds.length > 0) store.deleteMany(staleIds)

      for (const passage of passages) {
        const existing = store.getByIds([passage.id])[0]
        if (existing?.contentHash === passage.contentHash && existing.model === EMBEDDING_MODEL_ID) continue

        const [embedding] = await embedFn([passage.text], 'passage')
        if (embedding === undefined) continue
        store.upsert({
          id: passage.id,
          source: 'reference',
          key: slug,
          model: EMBEDDING_MODEL_ID,
          dims: embedding.length,
          embedding,
          contentHash: passage.contentHash,
        })
      }
    } finally {
      store.close()
    }
  }
}
