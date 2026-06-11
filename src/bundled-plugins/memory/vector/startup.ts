import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { MODEL_NAME, embed } from './embedder'
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
        model: MODEL_NAME,
        dims: embedding.length,
        embedding,
        contentHash: hashContent(passage.text),
      })
      count += 1
    }

    return count === 0 ? { built: false, count: 0 } : { built: true, count }
  } finally {
    store.close()
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
