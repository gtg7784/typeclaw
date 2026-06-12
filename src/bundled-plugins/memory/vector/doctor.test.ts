import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fragmentContentHash } from '../fragment-parser'
import { renderShard } from '../frontmatter'
import { runVectorIndexDoctor } from './doctor'
import { DIMS, EMBEDDING_MODEL_ID } from './embedder'
import { inspectVectorIndex } from './inspect'
import { VectorStore } from './store'

const testDirs: string[] = []

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('runVectorIndexDoctor', () => {
  it('warns without a fix when the index DB does not exist yet', async () => {
    const agentDir = createAgentDir()

    const result = await runVectorIndexDoctor(agentDir)

    expect(result.status).toBe('warning')
    expect(result.message).toContain('missing')
    expect(result.fix).toBeUndefined()
  })

  it('reports ok when every memory passage is indexed and consistent', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'alpha', 'Alpha', 'Body of alpha.')

    const result = await runVectorIndexDoctor(agentDir)

    expect(result.status).toBe('ok')
    expect(result.message).toContain('1/1')
  })

  it('warns (advisory, no fix) when a topic has no vector yet — backfill needed', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    writeTopic(agentDir, 'beta', 'Beta', 'Body of beta is not embedded.')

    const result = await runVectorIndexDoctor(agentDir)

    expect(result.status).toBe('warning')
    expect(result.details).toContainEqual('1 memory passage(s) need (re)indexing')
    expect(result.fix).toBeUndefined()
  })

  it('warns with a pruning fix when a vector row has no backing topic (orphan)', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'ghost', 'Ghost', 'Topic file was deleted.')

    const result = await runVectorIndexDoctor(agentDir)

    expect(result.status).toBe('warning')
    expect(result.details).toContainEqual('1 orphaned row(s) for deleted topics/fragments')
    expect(result.fix?.apply).toBeDefined()

    const fixOutcome = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger: noopLogger() })
    expect(fixOutcome.changedPaths).toEqual([])

    const store = VectorStore.open(dbPath(agentDir))
    const ids = store.getAll().map((row) => row.id)
    store.close()
    expect(ids).toEqual(['topic:alpha'])
  })

  it('warns with a pruning fix when a row is stamped with a different model variant', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'alpha', 'Alpha', 'Body of alpha.', 'Xenova/multilingual-e5-base@fp32')

    const before = inspectVectorIndex(dbPath(agentDir))
    if (before.kind !== 'ok') throw new Error('expected ok seed')
    expect(before.modelMismatch.length).toBe(1)

    const result = await runVectorIndexDoctor(agentDir)
    expect(result.status).toBe('warning')
    expect(result.details).toContainEqual('1 row(s) from a different embedding model/dims')
    expect(result.fix?.apply).toBeDefined()

    await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger: noopLogger() })

    const after = inspectVectorIndex(dbPath(agentDir))
    if (after.kind !== 'ok') throw new Error('expected ok after fix')
    expect(after.modelMismatch).toEqual([])
  })

  it('errors with a delete fix when the index DB is corrupted', async () => {
    const agentDir = createAgentDir()
    mkdirSync(join(agentDir, 'memory', '.vectors'), { recursive: true })
    writeFileSync(dbPath(agentDir), 'not a sqlite file at all')

    const result = await runVectorIndexDoctor(agentDir)

    expect(result.status).toBe('error')
    expect(result.fix?.apply).toBeDefined()

    const fixOutcome = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger: noopLogger() })
    expect(fixOutcome.changedPaths).toEqual([])
    expect(existsSync(dbPath(agentDir))).toBe(false)
  })

  it('warns with a pruning fix (no crash) when a row has a malformed embedding blob', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    // A blob whose byte length is not a multiple of 4 throws in Float32Array
    // decode; the doctor must still report it instead of crashing.
    insertRawRow(agentDir, { id: 'topic:broken', model: EMBEDDING_MODEL_ID, dims: DIMS, blobBytes: DIMS * 4 - 3 })

    const result = await runVectorIndexDoctor(agentDir)

    expect(result.status).toBe('warning')
    expect(result.details).toContainEqual('1 row(s) with a malformed embedding blob')
    expect(result.fix?.apply).toBeDefined()

    await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger: noopLogger() })

    const after = inspectVectorIndex(dbPath(agentDir))
    if (after.kind !== 'ok') throw new Error('expected ok after fix')
    expect(after.malformed).toEqual([])
    expect(after.rowIds).toEqual(['topic:alpha'])
  })

  it('prunes a current-model row whose dims differ from DIMS', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    insertRawRow(agentDir, { id: 'topic:wrongdims', model: EMBEDDING_MODEL_ID, dims: 256, blobBytes: 256 * 4 })

    const before = inspectVectorIndex(dbPath(agentDir))
    if (before.kind !== 'ok') throw new Error('expected ok seed')
    expect(before.modelMismatch).toEqual(['topic:wrongdims'])

    const result = await runVectorIndexDoctor(agentDir)
    expect(result.status).toBe('warning')
    expect(result.details).toContainEqual('1 row(s) from a different embedding model/dims')

    await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger: noopLogger() })

    const after = inspectVectorIndex(dbPath(agentDir))
    if (after.kind !== 'ok') throw new Error('expected ok after fix')
    expect(after.modelMismatch).toEqual([])
    expect(after.rowIds).toEqual(['topic:alpha'])
  })

  it('counts a row that is both orphaned and malformed once, not twice', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    seedTopicVector(agentDir, 'alpha', 'Alpha', 'Body of alpha.')
    // No topic file backs this row (orphaned) AND its blob is malformed; it
    // lands in both buckets, so the prune count must dedupe to 1.
    insertRawRow(agentDir, { id: 'topic:ghost', model: EMBEDDING_MODEL_ID, dims: DIMS, blobBytes: DIMS * 4 - 3 })

    const result = await runVectorIndexDoctor(agentDir)

    expect(result.status).toBe('warning')
    expect(result.fix?.description).toContain('Delete 1 ')

    const fixOutcome = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger: noopLogger() })
    expect(fixOutcome.summary).toContain('pruned 1 ')
    expect(fixOutcome.changedPaths).toEqual([])

    const after = inspectVectorIndex(dbPath(agentDir))
    if (after.kind !== 'ok') throw new Error('expected ok after fix')
    expect(after.rowIds).toEqual(['topic:alpha'])
  })
})

function createAgentDir(): string {
  const agentDir = join(tmpdir(), `typeclaw-vector-doctor-${randomUUID()}`)
  testDirs.push(agentDir)
  mkdirSync(join(agentDir, 'memory', 'topics'), { recursive: true })
  return agentDir
}

function dbPath(agentDir: string): string {
  return join(agentDir, 'memory', '.vectors', 'index.db')
}

function writeTopic(agentDir: string, slug: string, heading: string, body: string): void {
  writeFileSync(
    join(agentDir, 'memory', 'topics', `${slug}.md`),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function seedTopicVector(
  agentDir: string,
  slug: string,
  heading: string,
  body: string,
  model = EMBEDDING_MODEL_ID,
): void {
  const store = VectorStore.open(dbPath(agentDir))
  store.upsert({
    id: `topic:${slug}`,
    source: 'topic',
    key: slug,
    model,
    dims: DIMS,
    embedding: new Float32Array(DIMS),
    contentHash: fragmentContentHash({ topic: heading, body }),
  })
  store.close()
}

function insertRawRow(agentDir: string, row: { id: string; model: string; dims: number; blobBytes: number }): void {
  const db = new Database(dbPath(agentDir))
  db.query(
    'INSERT INTO vectors (id, source, key, model, dims, embedding, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    'topic',
    row.id.replace(/^topic:/, ''),
    row.model,
    row.dims,
    Buffer.alloc(row.blobBytes),
    row.id,
    '2026-06-11T00:00:00.000Z',
  )
  db.close()
}

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}
