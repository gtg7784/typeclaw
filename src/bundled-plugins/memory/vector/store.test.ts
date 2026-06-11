import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withGitLock } from '@/git/mutex'

import { VectorStore, type VectorRow } from './store'

const MODEL = 'Xenova/multilingual-e5-base'
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

      const results = store.query(embedding(768, { 0: 1, 1: 1 }), 1)

      expect(results).toHaveLength(1)
      expect(results[0]?.id).toBe('topic:a')
      expect(results[0]?.dims).toBe(768)
      expect(results[0]?.model).toBe(MODEL)
    } finally {
      store.close()
    }
  })

  it('QA 1.5: skips mismatched dimensions without attempting cross-dim cosine', () => {
    const store = openTestStore()
    try {
      store.upsert(row('topic:a', embedding(768, { 0: 1 })))
      store.upsert(row('topic:b', embedding(768, { 1: 1 })))

      expect(() => store.query(embedding(384, { 0: 1 }), 10)).not.toThrow()
      expect(store.query(embedding(384, { 0: 1 }), 10)).toEqual([])
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
