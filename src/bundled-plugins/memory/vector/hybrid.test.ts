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
      // production always embeds every shard, so the citing topic has a vector;
      // it is off-query here so the stream hit (cosine 1) clearly stands above it
      store.upsert(row('topic:package-manager', 'package-manager', vector({ 5: 1 })))

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
      // production always embeds every shard; both citing topics carry off-query
      // vectors so the stream hit (cosine 1) clearly stands above them
      store.upsert(row('topic:package-manager', 'package-manager', vector({ 5: 1 })))
      store.upsert(row('topic:docker-preferences', 'docker-preferences', vector({ 6: 1 })))

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

describe('hybridSearch relevance gate', () => {
  it('suppresses the vector lane when no topic clears the per-query baseline (no-match)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat band of topics, none meaningfully closer to the query than
      // the rest — the E5 no-match shape. Query has no keyword hit either.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }

      const results = await hybridSearch('zxqw nonexistent gibberish token', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('keeps a topic whose vector clearly stands above the baseline (real match)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat band plus one topic that aligns strongly with the query
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }
      writeTopic(agentDir, 'winner', 'Winner', 'The clearly matching topic for the query.')
      store.upsert(row('topic:winner', 'winner', vector({ 0: 1 })))

      const results = await hybridSearch('the matching query', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results[0]?.key).toBe('winner')
    } finally {
      store.close()
    }
  })

  it('lets a keyword hit survive even when the vector lane is fully suppressed', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat no-match vector band, but ONE topic literally contains the
      // rare token the user typed — high-precision lexical evidence must survive
      // the cosine no-match veto.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }
      writeTopic(agentDir, 'pr-851', 'PR 851', 'Notes about PR #851 zxqw-marker handling.')
      store.upsert(row('topic:pr-851', 'pr-851', bandedVector(0.779)))

      const results = await hybridSearch('zxqw-marker', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.map((r) => r.key)).toContain('pr-851')
    } finally {
      store.close()
    }
  })

  it('never suppresses a below-floor corpus to zero', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: only 3 shards — too few to estimate a baseline
      writeTopic(agentDir, 'a', 'A', 'Note A.')
      writeTopic(agentDir, 'b', 'B', 'Note B.')
      writeTopic(agentDir, 'c', 'C', 'Note C.')
      store.upsert(row('topic:a', 'a', bandedVector(0.78)))
      store.upsert(row('topic:b', 'b', bandedVector(0.779)))
      store.upsert(row('topic:c', 'c', bandedVector(0.778)))

      const results = await hybridSearch('anything', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it('keeps a stream-vector match even when the topic distribution is a flat no-match', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a full flat topic band (no topic clears the baseline) PLUS one
      // undreamed stream fragment that the query semantically matches, and NO
      // keyword hit — the freshness-window case. The topic no-match must not
      // veto the relevant stream candidate.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'fresh', 'A brand new undreamed observation.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, vector({ 0: 1 }), 'stream'))

      const results = await hybridSearch('zxqw nonexistent gibberish token', store, agentDir, 10, embedFrom({ 0: 1 }))

      const streamHit = results.find((r) => r.source === 'stream')
      expect(streamHit?.key).toBe(`2026-06-11#${fragmentId}`)
    } finally {
      store.close()
    }
  })

  it('suppresses an in-band stream neighbor on a no-match query (no closest-neighbor leak)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat topic no-match band AND a stream fragment that also sits
      // inside the band (an irrelevant nearest neighbor, not a real match), with
      // no keyword hit. The stream row must NOT inject — otherwise the no-match
      // query leaks closest-neighbors-regardless through the stream partition.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'noise', 'An unrelated undreamed fragment.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, bandedVector(0.781), 'stream'))

      const results = await hybridSearch('zxqw nonexistent gibberish token', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('drops a semantic-only stream row when there is no topic baseline to judge it', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: too few topics to form a baseline, plus an in-band stream neighbor
      // with no keyword corroboration — with no band to measure against, an
      // uncorroborated semantic-only stream row must not inject on a no-match.
      writeTopic(agentDir, 'a', 'A', 'Note A.')
      writeTopic(agentDir, 'b', 'B', 'Note B.')
      store.upsert(row('topic:a', 'a', bandedVector(0.5)))
      store.upsert(row('topic:b', 'b', bandedVector(0.49)))
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'noise', 'An unrelated undreamed fragment.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, bandedVector(0.5), 'stream'))

      const results = await hybridSearch('zxqw nonexistent gibberish token', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.some((r) => r.source === 'stream')).toBe(false)
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

// A unit vector whose cosine against the query unit vector vector({ 0: 1 }) is
// exactly `target`: put `target` on axis 0 and the remaining magnitude on a
// shared off-query axis, so a whole band of these sits at near-identical cosine
// to the query — the flat E5 no-match distribution.
function bandedVector(target: number): Float32Array {
  const result = new Float32Array(8)
  result[0] = target
  result[1] = Math.sqrt(Math.max(0, 1 - target * target))
  return result
}

function vector(values: Record<number, number>): Float32Array {
  const result = new Float32Array(8)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}
