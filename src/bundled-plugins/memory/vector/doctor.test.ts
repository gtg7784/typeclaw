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

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}
