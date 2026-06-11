import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type VectorRow = {
  id: string
  source: 'topic' | 'stream'
  key: string
  model: string
  dims: number
  embedding: Float32Array
  contentHash: string
  updatedAt: string
}

type StoredVectorRow = {
  id: string
  source: 'topic' | 'stream'
  key: string
  model: string
  dims: number
  embedding: Uint8Array
  content_hash: string
  updated_at: string
}

export class VectorStore {
  static open(dbPath: string): VectorStore {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.run(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    return new VectorStore(db)
  }

  private constructor(private readonly db: Database) {}

  upsert(row: Omit<VectorRow, 'updatedAt'>): void {
    const existing = this.db
      .query<{ content_hash: string; model: string }, [string]>('SELECT content_hash, model FROM vectors WHERE id = ?')
      .get(row.id)

    if (existing?.content_hash === row.contentHash && existing.model === row.model) {
      return
    }

    this.db
      .query(
        `INSERT INTO vectors (id, source, key, model, dims, embedding, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source = excluded.source,
           key = excluded.key,
           model = excluded.model,
           dims = excluded.dims,
           embedding = excluded.embedding,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.source,
        row.key,
        row.model,
        row.dims,
        Buffer.from(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength),
        row.contentHash,
        new Date().toISOString(),
      )
  }

  query(embedding: Float32Array, topK: number): VectorRow[] {
    if (topK <= 0) return []

    return this.getAll()
      .filter((row) => row.dims === embedding.length)
      .map((row) => ({ row, score: cosineSimilarity(embedding, row.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row }) => row)
  }

  delete(id: string): void {
    this.db.query('DELETE FROM vectors WHERE id = ?').run(id)
  }

  deleteMany(ids: string[]): void {
    const statement = this.db.query('DELETE FROM vectors WHERE id = ?')
    const remove = this.db.transaction((values: string[]) => {
      for (const id of values) statement.run(id)
    })
    remove(ids)
  }

  getAll(): VectorRow[] {
    return this.db.query<StoredVectorRow, []>('SELECT * FROM vectors ORDER BY id').all().map(toVectorRow)
  }

  getByIds(ids: string[]): VectorRow[] {
    const statement = this.db.query<StoredVectorRow, [string]>('SELECT * FROM vectors WHERE id = ?')
    return ids.flatMap((id) => {
      const row = statement.get(id)
      return row ? [toVectorRow(row)] : []
    })
  }

  close(): void {
    this.db.close()
  }
}

function toVectorRow(row: StoredVectorRow): VectorRow {
  return {
    id: row.id,
    source: row.source,
    key: row.key,
    model: row.model,
    dims: row.dims,
    embedding: blobToFloat32Array(row.embedding),
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  }
}

function blobToFloat32Array(blob: Uint8Array): Float32Array {
  const bytes = Buffer.from(blob)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Float32Array(buffer)
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let aMagnitude = 0
  let bMagnitude = 0

  for (let i = 0; i < a.length; i++) {
    const aValue = a[i] ?? 0
    const bValue = b[i] ?? 0
    dot += aValue * bValue
    aMagnitude += aValue * aValue
    bMagnitude += bValue * bValue
  }

  if (aMagnitude === 0 || bMagnitude === 0) return 0
  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude))
}
