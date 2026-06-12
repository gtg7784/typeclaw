import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderShard } from '../frontmatter'
import { EMBEDDING_MODEL_ID } from './embedder'
import { hybridSearch, type EmbedFn } from './hybrid'
import { VectorStore, type VectorRow } from './store'

const MODEL = EMBEDDING_MODEL_ID
const testDirs: string[] = []

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('hybridSearch', () => {
  it('QA 1.6: sums vector + keyword reciprocal ranks for a hit found by both lanes', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(agentDir, 'pr-651', 'PR 651 Review', 'PR #651 fixed channel reload handling.')
      writeTopic(
        agentDir,
        'semantic-cache',
        'Retrieval Cache',
        'Vector memory writes focused summaries after retrieval.',
      )
      store.upsert(row('topic:pr-651', 'pr-651', vector({ 0: 1 })))
      store.upsert(row('topic:semantic-cache', 'semantic-cache', vector({ 1: 1 })))

      const exactResults = await hybridSearch('PR #651', store, agentDir, 3, embedFrom({ 0: 1 }))
      const exact = exactResults.find((result) => result.key === 'pr-651')

      expect(exactResults.slice(0, 3).map((result) => result.key)).toContain('pr-651')
      expect(exact?.rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 10)

      const semanticResults = await hybridSearch(
        'focused memory summary retrieval',
        store,
        agentDir,
        3,
        embedFrom({ 1: 1 }),
      )
      const semantic = semanticResults.find((result) => result.key === 'semantic-cache')

      expect(semanticResults.slice(0, 3).map((result) => result.key)).toContain('semantic-cache')
      expect(semantic?.rrfScore).toBeCloseTo(1 / 61, 10)
    } finally {
      store.close()
    }
  })

  it('lifts a low-vector-rank topic above pure-cosine noise when the keyword lane corroborates', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(agentDir, 'person-note', 'Person Note', 'Reply conventions for 홍길동 in the group chat.')
      writeTopic(agentDir, 'noise-a', 'Noise A', 'Unrelated English PR review note about channel reload.')
      writeTopic(agentDir, 'noise-b', 'Noise B', 'Another unrelated English note about docker builds.')

      store.upsert(row('topic:noise-a', 'noise-a', vector({ 0: 0.9 })))
      store.upsert(row('topic:noise-b', 'noise-b', vector({ 0: 0.8 })))
      store.upsert(row('topic:person-note', 'person-note', vector({ 0: 0.1 })))

      const results = await hybridSearch('홍길동', store, agentDir, 3, embedFrom({ 0: 1 }))

      expect(results[0]?.key).toBe('person-note')
      expect(results[0]?.rrfScore).toBeGreaterThan(results[1]?.rrfScore ?? 0)
    } finally {
      store.close()
    }
  })

  it('QA 1.7: multilingual query can retrieve an English shard through the vector lane', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(
        agentDir,
        'english-i18n',
        'Internationalization Notes',
        'The UI supports Japanese and Korean locale routing.',
      )
      writeTopic(agentDir, 'docker-builds', 'Docker Builds', 'The base image build uses GHCR before npm publication.')
      store.upsert(row('topic:english-i18n', 'english-i18n', vector({ 2: 1 })))
      store.upsert(row('topic:docker-builds', 'docker-builds', vector({ 3: 1 })))

      const results = await hybridSearch(
        '한국어와 일본어 로케일은 어디에서 처리돼?',
        store,
        agentDir,
        3,
        embedFrom({ 2: 1 }),
      )

      expect(results.slice(0, 3).map((result) => result.key)).toContain('english-i18n')
      expect(results.find((result) => result.key === 'english-i18n')?.rrfScore).toBeCloseTo(1 / 61, 10)
    } finally {
      store.close()
    }
  })

  it('collapses a matched stream fragment to the topic that cites it', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a fragment cited by a topic, and a vector hit on that fragment
      const fragmentId = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      writeTopic(
        agentDir,
        'package-manager',
        'Package Manager',
        ['User uses pnpm.', 'fragments:', `- streams/2026-06-10#${fragmentId}`].join('\n'),
      )
      writeStreamFragment(agentDir, '2026-06-10', fragmentId, 'pnpm', 'User installs with pnpm.')
      store.upsert(row(`stream:2026-06-10#${fragmentId}`, `2026-06-10#${fragmentId}`, vector({ 0: 1 }), 'stream'))

      // when the fragment matches by vector
      const results = await hybridSearch('pnpm', store, agentDir, 5, embedFrom({ 0: 1 }))

      // then the result is the parent topic, not the standalone fragment
      const keys = results.map((result) => result.key)
      expect(keys).toContain('package-manager')
      expect(results.find((result) => result.source === 'stream')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('collapses a matched fragment to EVERY topic that cites it', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given one fragment cited by two distinct topics
      const fragmentId = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      writeTopic(
        agentDir,
        'package-manager',
        'Package Manager',
        ['User uses pnpm.', 'fragments:', `- streams/2026-06-10#${fragmentId}`].join('\n'),
      )
      writeTopic(
        agentDir,
        'docker-preferences',
        'Docker Preferences',
        ['User prefers minimal images.', 'fragments:', `- streams/2026-06-10#${fragmentId}`].join('\n'),
      )
      writeStreamFragment(agentDir, '2026-06-10', fragmentId, 'pnpm', 'Uses pnpm and minimal Docker images.')
      store.upsert(row(`stream:2026-06-10#${fragmentId}`, `2026-06-10#${fragmentId}`, vector({ 0: 1 }), 'stream'))

      // when the shared fragment matches by vector
      const results = await hybridSearch('pnpm docker', store, agentDir, 5, embedFrom({ 0: 1 }))

      // then BOTH citing topics surface, and the fragment never appears standalone
      const keys = results.map((result) => result.key)
      expect(keys).toContain('package-manager')
      expect(keys).toContain('docker-preferences')
      expect(results.find((result) => result.source === 'stream')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('ranks a parent by the MAX of its children, not the sum', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a topic citing two fragments, both matched by the keyword lane
      const idA = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      const idB = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
      writeTopic(
        agentDir,
        'editor',
        'Editor',
        ['User uses neovim.', 'fragments:', `- streams/2026-06-10#${idA}`, `- streams/2026-06-10#${idB}`].join('\n'),
      )
      writeStreamFragment(agentDir, '2026-06-10', idA, 'neovim', 'neovim is the editor.')
      writeStreamFragment(agentDir, '2026-06-10', idB, 'neovim', 'neovim config lives in lua.')

      // when both fragments match the keyword lane (no vector hits)
      const results = await hybridSearch('neovim', store, agentDir, 5, embedFrom({ 7: 1 }))
      const editor = results.find((result) => result.key === 'editor')

      // then the parent score is a single best-child RRF score, not the sum of both
      expect(editor).toBeDefined()
      expect(editor!.rrfScore).toBeLessThanOrEqual(1 / 61 + 1e-9)
    } finally {
      store.close()
    }
  })

  it('never returns a superseded fragment as a standalone keyword/stream result', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a topic whose belief switched to pnpm, keeping the bun fragment superseded
      const activeId = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      const supersededId = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
      writeTopic(
        agentDir,
        'package-manager',
        'Package Manager',
        [
          'User uses pnpm.',
          'fragments:',
          `- streams/2026-06-10#${activeId}`,
          'superseded:',
          `- streams/2026-06-10#${supersededId}`,
        ].join('\n'),
      )
      // both fragment bodies are on the live stream and both match the keyword "bun"
      writeStreamFragments(agentDir, '2026-06-10', [
        { id: activeId, topic: 'pnpm', body: 'User switched to pnpm from bun.' },
        { id: supersededId, topic: 'bun', body: 'User uses bun as the package manager.' },
      ])

      // when the query matches the superseded body (no vector hits)
      const results = await hybridSearch('bun', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then the superseded fragment never appears as a standalone stream result
      expect(results.some((result) => result.source === 'stream')).toBe(false)
      expect(results.some((result) => result.key === `2026-06-10#${supersededId}`)).toBe(false)
    } finally {
      store.close()
    }
  })

  it('keeps an undreamed fragment (no citing topic) as a stream result', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a fragment that no topic cites yet (freshness window)
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'deno', 'User is trying deno today.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, vector({ 0: 1 }), 'stream'))

      // when it matches
      const results = await hybridSearch('deno', store, agentDir, 5, embedFrom({ 0: 1 }))

      // then it resolves to itself as a stream result
      const hit = results.find((result) => result.source === 'stream')
      expect(hit?.key).toBe(`2026-06-11#${fragmentId}`)
    } finally {
      store.close()
    }
  })
})

function createFixture(): { agentDir: string; store: VectorStore } {
  const agentDir = join(tmpdir(), `typeclaw-hybrid-${randomUUID()}`)
  testDirs.push(agentDir)
  mkdirSync(join(agentDir, 'memory', 'topics'), { recursive: true })
  const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
  return { agentDir, store }
}

function writeTopic(agentDir: string, slug: string, heading: string, body: string): void {
  writeFileSync(
    join(agentDir, 'memory', 'topics', `${slug}.md`),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function writeStreamFragment(agentDir: string, date: string, id: string, topic: string, body: string): void {
  writeStreamFragments(agentDir, date, [{ id, topic, body }])
}

function writeStreamFragments(
  agentDir: string,
  date: string,
  fragments: Array<{ id: string; topic: string; body: string }>,
): void {
  const streamsDir = join(agentDir, 'memory', 'streams')
  mkdirSync(streamsDir, { recursive: true })
  const lines = fragments
    .map(({ id, topic, body }) =>
      JSON.stringify({
        type: 'fragment',
        id,
        ts: `${date}T12:00:00.000Z`,
        source: 'ses_test',
        entry: 'e1',
        topic,
        body,
      }),
    )
    .join('\n')
  writeFileSync(join(streamsDir, `${date}.jsonl`), `${lines}\n`)
}

function row(
  id: string,
  key: string,
  embedding: Float32Array,
  source: 'topic' | 'stream' = 'topic',
): Omit<VectorRow, 'updatedAt'> {
  return {
    id,
    source,
    key,
    model: MODEL,
    dims: embedding.length,
    embedding,
    contentHash: `hash:${id}`,
  }
}

function embedFrom(values: Record<number, number>): EmbedFn {
  return async () => [vector(values)]
}

function vector(values: Record<number, number>): Float32Array {
  const result = new Float32Array(8)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}
