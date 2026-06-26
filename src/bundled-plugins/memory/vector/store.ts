import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type OpenVectorStore = () => VectorStore

export type VectorRow = {
  id: string
  source: 'topic' | 'stream' | 'reference'
  key: string
  model: string
  dims: number
  embedding: Float32Array
  contentHash: string
  updatedAt: string
}

export type VectorMeta = { id: string; model: string; contentHash: string }

export type ScoredVectorRow = { row: VectorRow; score: number }

type StoredVectorRow = {
  id: string
  source: 'topic' | 'stream' | 'reference'
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

  query(embedding: Float32Array, topK: number, modelId: string): VectorRow[] {
    if (topK <= 0) return []
    return this.queryScored(embedding, modelId)
      .slice(0, topK)
      .map(({ row }) => row)
  }

  // Same cosine scan as `query` but returns every compatible row WITH its score
  // and unsliced, so a caller can reason about the full score distribution (the
  // relevance gate's per-query baseline) before deciding how many to keep.
  //
  // Filter by embedding identity, not dims alone: a stale row from a different
  // model/dtype variant can share the same dims but lives in an incompatible
  // vector space, so cosine against it is garbage. Excluding it here keeps a
  // partial re-embed (mixed variants mid-rebuild) at reduced recall, never
  // wrong scores.
  queryScored(embedding: Float32Array, modelId: string): ScoredVectorRow[] {
    // The query vector's magnitude is identical for every row in this scan, so
    // hoist it out of the per-row cosine instead of recomputing N times (each
    // recompute is 768 multiply-adds + a sqrt). Behavior is unchanged — same
    // cosine values, fewer operations on the brute-force hot path.
    const queryMagnitude = magnitude(embedding)
    return this.db
      .query<StoredVectorRow, [string, number]>('SELECT * FROM vectors WHERE model = ? AND dims = ?')
      .all(modelId, embedding.length)
      .map(toVectorRow)
      .map((row) => ({ row, score: cosineSimilarity(embedding, queryMagnitude, row.embedding) }))
      .sort((a, b) => b.score - a.score)
  }

  deleteOtherModels(modelId: string): void {
    this.db.query('DELETE FROM vectors WHERE model != ?').run(modelId)
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

  // Metadata only — never decodes the embedding BLOB, so a row whose blob is
  // malformed (byte length not a multiple of 4) can't throw here the way
  // getAll's Float32Array decode would.
  getAllMeta(): VectorMeta[] {
    return this.db
      .query<{ id: string; model: string; content_hash: string }, []>(
        'SELECT id, model, content_hash FROM vectors ORDER BY id',
      )
      .all()
      .map((row) => ({ id: row.id, model: row.model, contentHash: row.content_hash }))
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

function magnitude(v: Float32Array): number {
  let sumSquares = 0
  for (let i = 0; i < v.length; i++) {
    const value = v[i] ?? 0
    sumSquares += value * value
  }
  return Math.sqrt(sumSquares)
}

function cosineSimilarity(a: Float32Array, aMagnitude: number, b: Float32Array): number {
  let dot = 0
  let bSumSquares = 0

  for (let i = 0; i < a.length; i++) {
    const aValue = a[i] ?? 0
    const bValue = b[i] ?? 0
    dot += aValue * bValue
    bSumSquares += bValue * bValue
  }

  const bMagnitude = Math.sqrt(bSumSquares)
  if (aMagnitude === 0 || bMagnitude === 0) return 0
  return dot / (aMagnitude * bMagnitude)
}
