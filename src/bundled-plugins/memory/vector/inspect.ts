import { Database } from 'bun:sqlite'

import { DIMS, EMBEDDING_MODEL_ID } from './embedder'

// Read-only health probe for the vector index DB. Deliberately does NOT go
// through `VectorStore.open`: that path runs `CREATE TABLE IF NOT EXISTS`,
// which would silently "heal" a DB whose `vectors` table is missing — turning
// a corruption signal into a no-op. The doctor must observe state, not mutate
// it, so we open raw, validate the schema ourselves, and never write.

const EXPECTED_COLUMNS = ['id', 'source', 'key', 'model', 'dims', 'embedding', 'content_hash', 'updated_at'] as const

export type VectorIndexProblem =
  | { kind: 'unreadable'; detail: string }
  | { kind: 'corrupt'; detail: string[] }
  | { kind: 'schema-missing'; detail: string }

export type VectorIndexFinding =
  | VectorIndexProblem
  | { kind: 'ok'; rowCount: number; rowIds: string[]; modelMismatch: string[]; malformed: string[] }

type IntegrityRow = { result: string }
type SchemaRow = { name: string }
type RowMeta = { id: string; model: string; dims: number; embeddingBytes: number }

export function inspectVectorIndex(dbPath: string): VectorIndexFinding {
  let db: Database
  try {
    db = new Database(dbPath, { readonly: true })
  } catch (err) {
    return { kind: 'unreadable', detail: messageOf(err) }
  }

  try {
    const corruption = runQuickCheck(db)
    if (corruption !== null) return { kind: 'corrupt', detail: corruption }

    if (!hasVectorsTable(db)) {
      return { kind: 'schema-missing', detail: 'vectors table is absent' }
    }

    const missingColumns = missingVectorColumns(db)
    if (missingColumns.length > 0) {
      return { kind: 'schema-missing', detail: `vectors table missing columns: ${missingColumns.join(', ')}` }
    }

    return classifyRows(db)
  } catch (err) {
    // A read that throws after the DB opened (e.g. a malformed page surfaced
    // mid-scan that quick_check's sampling missed) is corruption, not an
    // unreadable file — the file opened fine.
    return { kind: 'corrupt', detail: [messageOf(err)] }
  } finally {
    db.close()
  }
}

function runQuickCheck(db: Database): string[] | null {
  // quick_check over integrity_check: integrity_check is O(db size) and can
  // blow the 5s doctor budget on a large index; quick_check skips the
  // expensive UNIQUE/foreign-key scans while still catching page-level
  // corruption. A healthy DB returns exactly one row: "ok". SQLite names the
  // result column after the pragma, hence `quick_check`, aliased to `result`.
  const rows = db.query<IntegrityRow, []>('SELECT quick_check AS result FROM pragma_quick_check').all()
  if (rows.length === 1 && rows[0]?.result === 'ok') return null
  return rows.map((row) => row.result)
}

function hasVectorsTable(db: Database): boolean {
  const row = db
    .query<SchemaRow, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('vectors')
  return row !== null
}

function missingVectorColumns(db: Database): string[] {
  const present = new Set(
    db
      .query<SchemaRow, []>('PRAGMA table_info(vectors)')
      .all()
      .map((row) => row.name),
  )
  return EXPECTED_COLUMNS.filter((column) => !present.has(column))
}

function classifyRows(db: Database): VectorIndexFinding {
  const rows = db
    .query<RowMeta, []>('SELECT id, model, dims, length(embedding) AS embeddingBytes FROM vectors ORDER BY id')
    .all()

  const rowIds: string[] = []
  const modelMismatch: string[] = []
  const malformed: string[] = []

  for (const row of rows) {
    rowIds.push(row.id)
    if (row.model !== EMBEDDING_MODEL_ID || row.dims !== DIMS) {
      modelMismatch.push(row.id)
      continue
    }
    // Float32 → 4 bytes per dim. A stored BLOB that disagrees can't decode to
    // a valid embedding, so cosine against it would be garbage.
    if (row.embeddingBytes !== row.dims * 4) malformed.push(row.id)
  }

  return { kind: 'ok', rowCount: rows.length, rowIds, modelMismatch, malformed }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
