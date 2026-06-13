import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withGitLock } from '@/git/mutex'

import { EMBEDDING_MODEL_ID } from './embedder'
import { VectorStore, type VectorRow } from './store'

const MODEL = EMBEDDING_MODEL_ID
const testDirs: string[] = []

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('VectorStore', () => {
  it('QA 1.4: stores 768-dim model-stamped rows and returns semantic top-1', () => {
    const store = openTestStore()
    try {
      store.upsert(row('topic:a', embedding(768, { 0: 0.99, 1: 1.01 })))
      store.upsert(row('topic:b', embedding(768, { 0: -1, 1: -1 })))
      store.upsert(row('stream:c', embedding(768, { 2: 1 })))

      const results = store.query(embedding(768, { 0: 1, 1: 1 }), 1, MODEL)

      expect(results).toHaveLength(1)
      expect(results[0]?.id).toBe('topic:a')
      expect(results[0]?.dims).toBe(768)
      expect(results[0]?.model).toBe(MODEL)
    } finally {
      store.close()
    }
  })

  it('scores exact cosine values (magnitude hoist preserves the math)', () => {
    const store = openTestStore()
    try {
      // query [1,1,0,...] vs row [1,0,0,...]: cosine = 1 / (sqrt(2) * 1) ≈ 0.7071
      store.upsert(row('topic:aligned', embedding(768, { 0: 1 })))
      // query vs row [0,0,1,...]: orthogonal, cosine = 0
      store.upsert(row('topic:orthogonal', embedding(768, { 2: 1 })))

      const scored = store.queryScored(embedding(768, { 0: 1, 1: 1 }), MODEL)

      const aligned = scored.find((s) => s.row.id === 'topic:aligned')
      const orthogonal = scored.find((s) => s.row.id === 'topic:orthogonal')
      expect(aligned?.score).toBeCloseTo(Math.SQRT1_2, 6)
      expect(orthogonal?.score).toBeCloseTo(0, 6)
    } finally {
      store.close()
    }
  })

  it('QA 1.5: skips mismatched dimensions without attempting cross-dim cosine', () => {
    const store = openTestStore()
    try {
      store.upsert(row('topic:a', embedding(768, { 0: 1 })))
      store.upsert(row('topic:b', embedding(768, { 1: 1 })))

      expect(() => store.query(embedding(384, { 0: 1 }), 10, MODEL)).not.toThrow()
      expect(store.query(embedding(384, { 0: 1 }), 10, MODEL)).toEqual([])
    } finally {
      store.close()
    }
  })

  it('query excludes rows from a different model/dtype variant (same dims)', () => {
    const store = openTestStore()
    try {
      // given: a stale fp32 row and a current q8 row, same id-space, same dims
      store.upsert({ ...row('topic:stale', embedding(768, { 0: 1 })), model: 'Xenova/multilingual-e5-base@fp32' })
      store.upsert(row('topic:current', embedding(768, { 0: 1 })))

      // when: querying with the current variant id
      const results = store.query(embedding(768, { 0: 1 }), 10, MODEL)

      // then: only the current-variant row is scored; the fp32 row never appears
      expect(results.map((r) => r.id)).toEqual(['topic:current'])
    } finally {
      store.close()
    }
  })

  it('deleteOtherModels purges rows whose model != current, keeps current', () => {
    const store = openTestStore()
    try {
      store.upsert({ ...row('topic:stale', embedding(768, { 0: 1 })), model: 'Xenova/multilingual-e5-base@fp32' })
      store.upsert(row('topic:current', embedding(768, { 1: 1 })))

      store.deleteOtherModels(MODEL)

      expect(store.getAll().map((r) => r.id)).toEqual(['topic:current'])
    } finally {
      store.close()
    }
  })

  it('QA 1.13: concurrent lazy index builds share a withGitLock-guarded build', async () => {
    const store = openTestStore()
    const agentDir = join(tmpdir(), `typeclaw-vector-agent-${randomUUID()}`)
    const buildStarted = deferred<void>()
    const buildCanFinish = deferred<void>()
    let buildCalls = 0
    let secondFinished = false

    try {
      const first = buildIndexIfNeeded(agentDir, store, async () => {
        buildCalls += 1
        buildStarted.resolve()
        await buildCanFinish.promise
        return [row('topic:a', embedding(768, { 0: 1 }))]
      })
      await buildStarted.promise

      const second = buildIndexIfNeeded(agentDir, store, async () => {
        buildCalls += 1
        return [row('topic:b', embedding(768, { 1: 1 }))]
      }).then(() => {
        secondFinished = true
      })
      await Promise.resolve()

      expect(buildCalls).toBe(1)
      expect(secondFinished).toBe(false)

      buildCanFinish.resolve()
      await Promise.all([first, second])

      expect(buildCalls).toBe(1)
      expect(store.getAll().map((stored) => stored.id)).toEqual(['topic:a'])
      expect(secondFinished).toBe(true)
    } finally {
      store.close()
      rmSync(agentDir, { recursive: true, force: true })
    }
  })
})

async function buildIndexIfNeeded(
  agentDir: string,
  store: VectorStore,
  build: () => Promise<Array<Omit<VectorRow, 'updatedAt'>>>,
): Promise<void> {
  if (store.getAll().length > 0) return

  await withGitLock(agentDir, async () => {
    if (store.getAll().length > 0) return
    for (const row of await build()) {
      store.upsert(row)
    }
  })
}

function openTestStore(): VectorStore {
  const dir = join(tmpdir(), `typeclaw-vector-store-${randomUUID()}`)
  testDirs.push(dir)
  return VectorStore.open(join(dir, 'index.db'))
}

function row(id: string, value: Float32Array): Omit<VectorRow, 'updatedAt'> {
  return {
    id,
    source: id.startsWith('stream:') ? 'stream' : 'topic',
    key: id,
    model: MODEL,
    dims: value.length,
    embedding: value,
    contentHash: `hash:${id}`,
  }
}

function embedding(dims: number, values: Record<number, number>): Float32Array {
  const result = new Float32Array(dims)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
