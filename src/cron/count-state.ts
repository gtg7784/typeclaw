import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CronJob } from './schema'

export const CRON_STATE_FILE = join('cron', 'state.json')

type StateEntry = {
  progressFingerprint: string
  firedCount: number
  lastAcceptedAt: string
}

type StateFile = {
  version: 1
  jobs: Record<string, StateEntry>
}

export type CountStore = {
  // Fingerprint-aware: returns 0 unless the stored entry's recurrence
  // fingerprint matches `job`. A stale fire from a previous job definition (or
  // a resurrected entry after reload) therefore can't gate the live job.
  get: (id: string, job: CronJob) => number
  // Resolves `true` when the fire was accepted and counted, `false` when the
  // job is no longer in the live set (removed/replaced while this was queued).
  // Callers use the result to skip dispatching a stale job, not just to avoid
  // miscounting it. The verdict is computed inside the write mutex, so it
  // reflects any reconcile that landed before the write ran.
  increment: (id: string, job: CronJob, at: number) => Promise<boolean>
  // Re-applies boot-time reconciliation against a new job set (called on
  // `typeclaw reload`) so re-added/changed jobs don't inherit stale counts.
  reconcile: (jobs: CronJob[]) => Promise<void>
}

export type CountStoreIO = {
  read: (path: string) => Promise<string | null>
  write: (path: string, data: string) => Promise<void>
}

const realIO: CountStoreIO = {
  read: async (path) => (existsSync(path) ? readFile(path, 'utf8') : null),
  // Temp-file + rename keeps readers from ever seeing a half-written file.
  write: async (path, data) => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, path)
  },
}

// `progressFingerprint` identifies the job's RECURRENCE IDENTITY, deliberately
// excluding the mutable limits (`count`, `until`) and `enabled`. Two jobs with
// the same id but a changed schedule/target are different recurrences, so the
// fire counter resets. Bumping only `count` (3 → 5) leaves the fingerprint
// unchanged, so progress is preserved and the job resumes firing.
export function progressFingerprint(job: CronJob): string {
  return JSON.stringify({
    id: job.id,
    schedule: job.schedule ?? null,
    at: job.at ?? null,
    timezone: job.timezone ?? null,
    kind: job.kind,
    target: targetIdentity(job),
  })
}

function targetIdentity(job: CronJob): unknown {
  if (job.kind === 'prompt') return { prompt: job.prompt, subagent: job.subagent ?? null, payload: job.payload ?? null }
  if (job.kind === 'exec') return job.command
  return { handler: String(job.handler) }
}

function matchingCount(entry: StateEntry | undefined, job: CronJob): number {
  if (entry === undefined) return 0
  return entry.progressFingerprint === progressFingerprint(job) ? entry.firedCount : 0
}

function serialize(state: StateFile): string {
  return JSON.stringify(state)
}

function activeFingerprints(jobs: CronJob[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const job of jobs) {
    if (job.count !== undefined) map.set(job.id, progressFingerprint(job))
  }
  return map
}

export async function createCountStore(
  agentDir: string,
  jobs: CronJob[],
  io: CountStoreIO = realIO,
): Promise<CountStore> {
  const path = join(agentDir, CRON_STATE_FILE)
  const onDisk = await readState(path, io)
  const state: StateFile = reconcile(onDisk, jobs)
  // Serializes writes so concurrent increments (two jobs firing in the same
  // tick) can't clobber each other via read-modify-write races.
  let tail: Promise<void> = Promise.resolve()
  // Guards against a straggler fire that lost a reconcile race re-adding a
  // tombstone for a removed job: an increment whose id/fingerprint is not in
  // the current live set is dropped. Maps each live id to its fingerprint.
  let active = activeFingerprints(jobs)

  // Only touch disk when reconciliation actually pruned/reset something.
  // Avoids a force-committed no-op rewrite of cron/state.json on every boot.
  if (serialize(state) !== serialize(onDisk)) {
    await persist(path, state, io)
  }

  return {
    get: (id, job) => matchingCount(state.jobs[id], job),
    increment: (id, job, at) => {
      const fp = progressFingerprint(job)
      const run = tail.then(async () => {
        // Re-check INSIDE the tail body, not just before queueing: a reconcile
        // can land synchronously between the queue and this body running, so a
        // sync-only guard would still let a straggler write a tombstone for a
        // job that's since been removed. `active` reflects the latest reconcile.
        if (active.get(id) !== fp) return false
        const prev = matchingCount(state.jobs[id], job)
        state.jobs[id] = {
          progressFingerprint: fp,
          firedCount: prev + 1,
          lastAcceptedAt: new Date(at).toISOString(),
        }
        await persist(path, state, io)
        return true
      })
      tail = run.then(
        () => {},
        () => {},
      )
      return run
    },
    reconcile: (nextJobs) => {
      // In-memory map is authoritative for `get`, so it must settle before the
      // caller arms timers; only the on-disk persist trails behind the mutex.
      active = activeFingerprints(nextJobs)
      state.jobs = reconcile(state, nextJobs).jobs
      const run = tail.then(async () => {
        await persist(path, state, io)
      })
      tail = run.catch(() => {})
      return run
    },
  }
}

function emptyState(): StateFile {
  return { version: 1, jobs: {} }
}

async function readState(path: string, io: CountStoreIO): Promise<StateFile> {
  const raw = await io.read(path)
  if (raw === null) return emptyState()
  try {
    return validateState(JSON.parse(raw))
  } catch {
    return emptyState()
  }
}

// Durable on-disk state is untrusted: a corrupt or hand-edited file must never
// crash the scheduler or feed a bogus count into expiry. Drop the whole file
// on a version mismatch, and skip individual entries that aren't well-formed.
function validateState(raw: unknown): StateFile {
  if (typeof raw !== 'object' || raw === null) return emptyState()
  const obj = raw as { version?: unknown; jobs?: unknown }
  if (obj.version !== 1 || typeof obj.jobs !== 'object' || obj.jobs === null) return emptyState()

  const jobs: Record<string, StateEntry> = {}
  for (const [id, value] of Object.entries(obj.jobs as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const e = value as Record<string, unknown>
    if (typeof e.progressFingerprint !== 'string') continue
    if (typeof e.firedCount !== 'number' || !Number.isInteger(e.firedCount) || e.firedCount < 0) continue
    if (typeof e.lastAcceptedAt !== 'string') continue
    jobs[id] = {
      progressFingerprint: e.progressFingerprint,
      firedCount: e.firedCount,
      lastAcceptedAt: e.lastAcceptedAt,
    }
  }
  return { version: 1, jobs }
}

// Boot/reload reconciliation. The scary footgun is a job id removed and later
// re-added with the SAME id: without this, the re-added job would inherit the
// old counter and never fire. We drop entries for ids that are gone or no
// longer counted, and reset entries whose recurrence fingerprint changed.
export function reconcile(state: StateFile, jobs: CronJob[]): StateFile {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const next: Record<string, StateEntry> = {}
  for (const [id, entry] of Object.entries(state.jobs)) {
    const job = byId.get(id)
    if (!job || job.count === undefined) continue
    if (entry.progressFingerprint !== progressFingerprint(job)) continue
    next[id] = entry
  }
  return { version: 1, jobs: next }
}

async function persist(path: string, state: StateFile, io: CountStoreIO): Promise<void> {
  await io.write(path, JSON.stringify(state, null, 2))
}
