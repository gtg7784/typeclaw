import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { PluginCheckResult } from '@/plugin'

import { inspectVectorIndex, type VectorIndexProblem } from './inspect'
import { collectPassages, findMissingPassages } from './passages'
import { VectorStore } from './store'

export const VECTOR_INDEX_REL_PATH = join('memory', '.vectors', 'index.db')

export async function runVectorIndexDoctor(agentDir: string): Promise<PluginCheckResult> {
  const dbPath = join(agentDir, VECTOR_INDEX_REL_PATH)

  if (!existsSync(dbPath)) {
    return {
      status: 'warning',
      message: 'vector memory index DB is missing; it rebuilds on the next startup',
    }
  }

  const finding = inspectVectorIndex(dbPath)

  if (finding.kind === 'unreadable' || finding.kind === 'corrupt' || finding.kind === 'schema-missing') {
    return corruptionResult(dbPath, finding)
  }

  const passages = await collectPassages(agentDir)
  const wantedIds = new Set(passages.map((passage) => passage.id))
  const orphans = finding.rowIds.filter((id) => !wantedIds.has(id))
  const backfillCount = countBackfill(dbPath, passages)

  return summarize(dbPath, {
    rowCount: finding.rowCount,
    orphans,
    modelMismatch: finding.modelMismatch,
    malformed: finding.malformed,
    backfillCount,
    indexedCount: passages.length - backfillCount,
    wantedCount: passages.length,
  })
}

function countBackfill(dbPath: string, passages: Awaited<ReturnType<typeof collectPassages>>): number {
  const store = VectorStore.open(dbPath)
  try {
    return findMissingPassages(store, passages).length
  } finally {
    store.close()
  }
}

type Summary = {
  rowCount: number
  orphans: string[]
  modelMismatch: string[]
  malformed: string[]
  backfillCount: number
  indexedCount: number
  wantedCount: number
}

function summarize(dbPath: string, s: Summary): PluginCheckResult {
  // Dedupe: a row can be both orphaned and malformed/variant, so the union by
  // id keeps the count and the deletion list honest.
  const repairable = [...new Set([...s.orphans, ...s.modelMismatch, ...s.malformed])]
  const details: string[] = []
  if (s.orphans.length > 0) details.push(`${s.orphans.length} orphaned row(s) for deleted topics/fragments`)
  if (s.modelMismatch.length > 0) {
    details.push(`${s.modelMismatch.length} row(s) from a different embedding model/dims`)
  }
  if (s.malformed.length > 0) details.push(`${s.malformed.length} row(s) with a malformed embedding blob`)
  if (s.backfillCount > 0) details.push(`${s.backfillCount} memory passage(s) need (re)indexing`)

  if (details.length === 0) {
    return { status: 'ok', message: `vector index healthy: ${s.indexedCount}/${s.wantedCount} memory passages indexed` }
  }

  const result: PluginCheckResult = {
    status: 'warning',
    message: `vector index has ${details.length} issue(s); ${s.rowCount} row(s) stored`,
    details,
  }

  if (repairable.length > 0) {
    result.fix = {
      description: `Delete ${repairable.length} orphaned/incompatible vector row(s); backfill happens on the next startup`,
      apply: async () => {
        const store = VectorStore.open(dbPath)
        try {
          store.deleteMany(repairable)
        } finally {
          store.close()
        }
        return {
          summary: `pruned ${repairable.length} stale vector row(s) from ${VECTOR_INDEX_REL_PATH}`,
          changedPaths: [],
        }
      },
    }
  }

  return result
}

function corruptionResult(dbPath: string, finding: VectorIndexProblem): PluginCheckResult {
  const details = finding.kind === 'corrupt' ? finding.detail : [finding.detail]
  return {
    status: 'error',
    message:
      finding.kind === 'schema-missing'
        ? 'vector index DB has an invalid schema'
        : 'vector index DB is unreadable or corrupted',
    details,
    fix: {
      description: `Delete the corrupted ${VECTOR_INDEX_REL_PATH}; it rebuilds from memory on the next startup`,
      apply: async () => {
        await rm(dbPath, { force: true })
        return { summary: `deleted corrupted ${VECTOR_INDEX_REL_PATH}`, changedPaths: [] }
      },
    },
  }
}
