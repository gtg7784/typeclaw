import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EmbedFn } from './hybrid'
import { referencePassagesForOne } from './passages'
import { makeReferenceStoredHook } from './reference-index-on-write'
import { VectorStore } from './store'

const testDirs: string[] = []

afterEach(async () => {
  for (const dir of testDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('makeReferenceStoredHook', () => {
  it('embeds a freshly stored reference immediately', async () => {
    const store = await createStore()
    let embedCalls = 0
    const embedFn: EmbedFn = async (texts, type) => {
      embedCalls += 1
      expect(type).toBe('passage')
      return texts.map(() => vector({ 0: 1 }))
    }

    try {
      const hook = makeReferenceStoredHook(store, embedFn)
      await hook({ slug: 'sql-query', body: 'SELECT 1;\n' })

      const [row] = store.getByIds(['reference:sql-query#0'])
      expect(row?.source).toBe('reference')
      expect(row?.key).toBe('sql-query')
      expect(embedCalls).toBe(1)
    } finally {
      store.close()
    }
  })

  it('skips re-embedding an unchanged reference body', async () => {
    const store = await createStore()
    let embedCalls = 0
    const embedFn: EmbedFn = async (texts) => {
      embedCalls += 1
      return texts.map(() => vector({ 0: 1 }))
    }

    try {
      const hook = makeReferenceStoredHook(store, embedFn)
      await hook({ slug: 'sql-query', body: 'SELECT 1;\n' })
      const updatedAt = store.getByIds(['reference:sql-query#0'])[0]?.updatedAt

      await hook({ slug: 'sql-query', body: 'SELECT 1;\n' })

      expect(store.getByIds(['reference:sql-query#0'])[0]?.updatedAt).toBe(updatedAt)
      expect(embedCalls).toBe(1)
    } finally {
      store.close()
    }
  })

  it('prunes stale higher-index chunks when a re-stored body shrinks', async () => {
    const store = await createStore()
    const longBody = 'x'.repeat(5000)
    const embedFn: EmbedFn = async (texts) => texts.map(() => vector({ 0: 1 }))

    try {
      const hook = makeReferenceStoredHook(store, embedFn)
      await hook({ slug: 'big', body: longBody })
      const initialChunks = referencePassagesForOne('big', longBody).length
      expect(initialChunks).toBeGreaterThan(1)
      expect(store.getByIds(['reference:big#0'])[0]).toBeDefined()
      expect(store.getByIds([`reference:big#${initialChunks - 1}`])[0]).toBeDefined()

      await hook({ slug: 'big', body: 'short\n' })

      expect(store.getByIds(['reference:big#0'])[0]).toBeDefined()
      expect(store.getByIds([`reference:big#${initialChunks - 1}`])[0]).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('embeds no rows for a demoted reference', async () => {
    const store = await createStore()
    let embedCalls = 0
    const embedFn: EmbedFn = async (texts) => {
      embedCalls += 1
      return texts.map(() => vector({ 0: 1 }))
    }

    try {
      const hook = makeReferenceStoredHook(store, embedFn)
      await hook({ slug: 'demoted-ref', body: 'SELECT 1;\n', demoted: true })

      expect(store.getByIds(['reference:demoted-ref#0'])[0]).toBeUndefined()
      expect(embedCalls).toBe(0)
    } finally {
      store.close()
    }
  })
})

async function createStore(): Promise<VectorStore> {
  const agentDir = join(tmpdir(), `typeclaw-reference-on-write-${randomUUID()}`)
  testDirs.push(agentDir)
  await mkdir(join(agentDir, 'memory', '.vectors'), { recursive: true })
  return VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
}

function vector(values: Record<number, number>): Float32Array {
  const result = new Float32Array(8)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}
