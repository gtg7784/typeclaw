import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import { renderShard } from './frontmatter'
import { __setQueryEmbedFnForTests } from './index'
import { topicShardPath, topicsDir } from './paths'
import { EMBEDDING_MODEL_ID } from './vector/embedder'
import type { EmbedFn } from './vector/hybrid'
import { VectorStore, type VectorRow } from './vector/store'

const DIMS = 8
const BAND_SIZE = 8
// A single token that appears in no slug, heading, or body, so the keyword lane
// returns nothing and the vector lane is the ONLY source a hit can come from —
// any retrieved topic proves real semantic retrieval ran, not substring search.
const QUERY = 'zzqxvtrprobe'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-vector-retrieval-'))
})

afterEach(async () => {
  __setQueryEmbedFnForTests(undefined)
  await rm(agentDir, { recursive: true, force: true })
})

describe('vector retrieval end-to-end through session.turn.start', () => {
  test('index-mode turn surfaces only the vector winner and suppresses the no-match band', async () => {
    // given: a flat band of decoy topics plus one winner aligned to the query
    // axis. Bodies share no token with the query, so the keyword lane is inert
    // and only the real vector lane can surface the winner. Bodies are sized so
    // their byte sum alone exceeds the 4 KB budget, forcing index mode (the only
    // path that runs hybridSearch) regardless of frontmatter overhead.
    for (let i = 0; i < BAND_SIZE; i++) {
      await writeTopic(agentDir, `decoy-${i}`, `Decoy ${i}`, `culinary filler ${i}. ${pad(900)}`)
    }
    await writeTopic(agentDir, 'orbital-mechanics', 'Orbital Mechanics', `Apogee perigee inclination. ${pad(900)}`)

    seedVectors(agentDir)
    __setQueryEmbedFnForTests(queryAligned())

    const infos: string[] = []
    const exports = await bootVectorPlugin(4096, capturingLogger(infos))
    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_e2e', agentDir, userPrompt: QUERY, retrievalContext },
      hookCtx(),
    )

    // then: the over-budget plan took the index path (not direct mode, which
    // would render every shard), the relevance gate kept the vector-aligned
    // winner above the band and suppressed every decoy, and the winner's body
    // rendered under the index-mode `# Memory` framing.
    expect(infos).toContain('[vector-retrieval] mode=index topic_results=1 stream_results=0')
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## Orbital Mechanics')
    expect(retrievalContext.results).toContain('Apogee perigee inclination.')
    expect(retrievalContext.results).not.toContain('## Decoy')
    expect(retrievalContext.results).not.toContain('## Retrieved memory')
  })
})

async function bootVectorPlugin(injectionBudgetBytes: number, logger = createPluginLogger('memory')) {
  const memoryPlugin = (await import('./index')).default
  const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes, vector: { enabled: true } })
  if (!parsed.success) throw new Error(parsed.error.message)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger,
    permissions: noopPermissionService,
    spawnSubagent: async () => {},
    isBooted: () => true,
  })
  return memoryPlugin.plugin(ctx)
}

function hookCtx() {
  return { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
}

function capturingLogger(infos: string[]) {
  return {
    ...createPluginLogger('memory'),
    info: (msg: string) => {
      infos.push(msg)
    },
  }
}

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function seedVectors(dir: string): void {
  const store = VectorStore.open(join(dir, 'memory', '.vectors', 'index.db'))
  try {
    for (let i = 0; i < BAND_SIZE; i++) {
      store.upsert(unitRow(`topic:decoy-${i}`, `decoy-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
    }
    store.upsert(unitRow('topic:orbital-mechanics', 'orbital-mechanics', alignedVector()))
  } finally {
    store.close()
  }
}

function unitRow(id: string, key: string, embedding: Float32Array): Omit<VectorRow, 'updatedAt'> {
  return { id, source: 'topic', key, model: EMBEDDING_MODEL_ID, dims: DIMS, embedding, contentHash: `hash:${id}` }
}

function queryAligned(): EmbedFn {
  return async () => [alignedVector()]
}

function alignedVector(): Float32Array {
  const result = new Float32Array(DIMS)
  result[0] = 1
  return result
}

// A unit vector whose cosine against the query (axis 0) is exactly `target`, so
// a whole band sits at near-identical cosine — the flat E5 no-match shape the
// relevance gate suppresses. Mirrors the `bandedVector` helper in hybrid.test.ts.
function bandedVector(target: number): Float32Array {
  const result = new Float32Array(DIMS)
  result[0] = target
  result[1] = Math.sqrt(Math.max(0, 1 - target * target))
  return result
}

function pad(n: number): string {
  return 'x'.repeat(n)
}
