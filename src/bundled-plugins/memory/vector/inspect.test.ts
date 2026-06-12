import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DIMS, EMBEDDING_MODEL_ID } from './embedder'
import { inspectVectorIndex } from './inspect'
import { VectorStore } from './store'

const testDirs: string[] = []

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('inspectVectorIndex', () => {
  it('reports ok with row ids for a healthy index', () => {
    const dbPath = newDbPath()
    const store = VectorStore.open(dbPath)
    store.upsert(healthyRow('topic:a', 'topic', 'a'))
    store.upsert(healthyRow('stream:2026-06-11#frag-1', 'stream', '2026-06-11#frag-1'))
    store.close()

    const finding = inspectVectorIndex(dbPath)

    expect(finding.kind).toBe('ok')
    if (finding.kind !== 'ok') throw new Error('expected ok')
    expect(finding.rowCount).toBe(2)
    expect(finding.rowIds).toEqual(['stream:2026-06-11#frag-1', 'topic:a'])
    expect(finding.modelMismatch).toEqual([])
    expect(finding.malformed).toEqual([])
  })

  it('does NOT create the vectors table when probing an empty DB (read-only)', () => {
    const dbPath = newDbPath()
    new Database(dbPath).close()

    const finding = inspectVectorIndex(dbPath)

    expect(finding.kind).toBe('schema-missing')
    const after = new Database(dbPath, { readonly: true })
    const table = after
      .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('vectors')
    after.close()
    expect(table).toBeNull()
  })

  it('flags rows stamped with a different model/dtype variant', () => {
    const dbPath = newDbPath()
    const db = openVectorsTable(dbPath)
    insertRaw(db, { id: 'topic:legacy', model: 'Xenova/multilingual-e5-base@fp32', dims: DIMS, bytes: DIMS * 4 })
    insertRaw(db, { id: 'topic:current', model: EMBEDDING_MODEL_ID, dims: DIMS, bytes: DIMS * 4 })
    db.close()

    const finding = inspectVectorIndex(dbPath)

    if (finding.kind !== 'ok') throw new Error('expected ok')
    expect(finding.modelMismatch).toEqual(['topic:legacy'])
    expect(finding.malformed).toEqual([])
  })

  it('flags rows whose embedding blob byte length disagrees with dims', () => {
    const dbPath = newDbPath()
    const db = openVectorsTable(dbPath)
    insertRaw(db, { id: 'topic:truncated', model: EMBEDDING_MODEL_ID, dims: DIMS, bytes: DIMS * 4 - 16 })
    db.close()

    const finding = inspectVectorIndex(dbPath)

    if (finding.kind !== 'ok') throw new Error('expected ok')
    expect(finding.modelMismatch).toEqual([])
    expect(finding.malformed).toEqual(['topic:truncated'])
  })

  it('reports schema-missing when the vectors table lacks expected columns', () => {
    const dbPath = newDbPath()
    const db = new Database(dbPath)
    db.run('CREATE TABLE vectors (id TEXT PRIMARY KEY, model TEXT)')
    db.close()

    const finding = inspectVectorIndex(dbPath)

    expect(finding.kind).toBe('schema-missing')
    if (finding.kind !== 'schema-missing') throw new Error('expected schema-missing')
    expect(finding.detail).toContain('embedding')
  })

  it('reports corrupt for a file that is not a valid SQLite database', () => {
    const dbPath = newDbPath()
    writeFileSync(dbPath, 'this is not a sqlite database, just plain garbage bytes')

    const finding = inspectVectorIndex(dbPath)

    expect(finding.kind === 'corrupt' || finding.kind === 'unreadable').toBe(true)
  })
})

function newDbPath(): string {
  const dir = join(tmpdir(), `typeclaw-inspect-${randomUUID()}`)
  testDirs.push(dir)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'index.db')
}

function healthyRow(id: string, source: 'topic' | 'stream', key: string) {
  return { id, source, key, model: EMBEDDING_MODEL_ID, dims: DIMS, embedding: new Float32Array(DIMS), contentHash: id }
}

function openVectorsTable(dbPath: string): Database {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE vectors (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, key TEXT NOT NULL, model TEXT NOT NULL,
      dims INTEGER NOT NULL, embedding BLOB NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `)
  return db
}

function insertRaw(db: Database, row: { id: string; model: string; dims: number; bytes: number }): void {
  db.query(
    'INSERT INTO vectors (id, source, key, model, dims, embedding, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    'topic',
    row.id.replace(/^topic:/, ''),
    row.model,
    row.dims,
    Buffer.alloc(row.bytes),
    row.id,
    '2026-06-11T00:00:00.000Z',
  )
}
