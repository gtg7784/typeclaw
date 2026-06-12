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
    // axis. Every body shares NO word with the query, so a regression to the
    // substring/token memory_search lane would retrieve nothing — only the real
    // vector lane can surface the winner. The bodies sum past the 4 KB budget,
    // forcing index mode (the only path that runs hybridSearch).
    for (let i = 0; i < BAND_SIZE; i++) {
      await writeTopic(agentDir, `decoy-${i}`, `Decoy ${i}`, `Carbonara guanciale pecorino ${i}. ${pad(700)}`)
    }
    await writeTopic(agentDir, 'orbital-mechanics', 'Orbital Mechanics', `Apogee perigee inclination. ${pad(700)}`)

    seedBand(agentDir)
    seedWinner(agentDir, 'topic:orbital-mechanics', 'orbital-mechanics')
    __setQueryEmbedFnForTests(queryAligned())

    const exports = await bootVectorPlugin(4096)
    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_e2e', agentDir, userPrompt: 'how do satellites stay in orbit', retrievalContext },
      hookCtx(),
    )

    // then: the relevance gate kept the vector-aligned winner above the band and
    // suppressed every decoy. The render reached the index-mode `# Memory`
    // framing with the winner's body, not the lag-by-one retrieval-cache path.
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## Orbital Mechanics')
    expect(retrievalContext.results).toContain('Apogee perigee inclination.')
    expect(retrievalContext.results).not.toContain('## Decoy')
    expect(retrievalContext.results).not.toContain('## Retrieved memory')
  })
})

async function bootVectorPlugin(injectionBudgetBytes: number) {
  const memoryPlugin = (await import('./index')).default
  const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes, vector: { enabled: true } })
  if (!parsed.success) throw new Error(parsed.error.message)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger: createPluginLogger('memory'),
    permissions: noopPermissionService,
    spawnSubagent: async () => {},
    isBooted: () => true,
  })
  return memoryPlugin.plugin(ctx)
}

function hookCtx() {
  return { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
}

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function seedBand(dir: string): void {
  withStore(dir, (store) => {
    for (let i = 0; i < BAND_SIZE; i++) {
      store.upsert(unitRow(`topic:decoy-${i}`, `decoy-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
    }
  })
}

function seedWinner(dir: string, id: string, key: string): void {
  withStore(dir, (store) => store.upsert(unitRow(id, key, alignedVector())))
}

function withStore(dir: string, fn: (store: VectorStore) => void): void {
  const store = VectorStore.open(join(dir, 'memory', '.vectors', 'index.db'))
  try {
    fn(store)
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
