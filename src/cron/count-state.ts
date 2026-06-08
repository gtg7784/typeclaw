import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CronJob } from './schema'

export const CRON_STATE_FILE = join('cron', 'state.json')

type StateEntry = {
  progressFingerprint: string
  firedCount: number
  lastAcceptedAt?: string
  updatedAt: string
}

type StateFile = {
  version: 1
  jobs: Record<string, StateEntry>
}

export type CountStore = {
  get: (id: string) => number
  increment: (id: string, job: CronJob, at: number) => Promise<void>
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

export async function createCountStore(
  agentDir: string,
  jobs: CronJob[],
  io: CountStoreIO = realIO,
): Promise<CountStore> {
  const path = join(agentDir, CRON_STATE_FILE)
  const reconciled = reconcile(await readState(path, io), jobs)
  const state: StateFile = reconciled
  // Serializes writes so concurrent increments (two jobs firing in the same
  // tick) can't clobber each other via read-modify-write races.
  let tail: Promise<void> = Promise.resolve()

  await persist(path, state, io)

  return {
    get: (id) => state.jobs[id]?.firedCount ?? 0,
    increment: (id, job, at) => {
      const run = tail.then(async () => {
        const prev = state.jobs[id]?.firedCount ?? 0
        state.jobs[id] = {
          progressFingerprint: progressFingerprint(job),
          firedCount: prev + 1,
          lastAcceptedAt: new Date(at).toISOString(),
          updatedAt: new Date(at).toISOString(),
        }
        await persist(path, state, io)
      })
      tail = run.catch(() => {})
      return run
    },
    reconcile: (nextJobs) => {
      // In-memory map is authoritative for `get`, so it must settle before the
      // caller arms timers; only the on-disk persist trails behind the mutex.
      state.jobs = reconcile(state, nextJobs).jobs
      const run = tail.then(async () => {
        await persist(path, state, io)
      })
      tail = run.catch(() => {})
      return run
    },
  }
}

async function readState(path: string, io: CountStoreIO): Promise<StateFile> {
  const raw = await io.read(path)
  if (raw === null) return { version: 1, jobs: {} }
  try {
    const parsed = JSON.parse(raw) as StateFile
    if (parsed.version !== 1 || typeof parsed.jobs !== 'object' || parsed.jobs === null) {
      return { version: 1, jobs: {} }
    }
    return parsed
  } catch {
    return { version: 1, jobs: {} }
  }
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
