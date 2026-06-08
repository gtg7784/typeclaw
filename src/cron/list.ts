import type { RegisteredCronJob } from '@/plugin'

import { computeNextFire } from './scheduler'
import type { CronJob } from './schema'

// `plugin` carries `localId` (the original key on `definePlugin({ cronJobs })`)
// so callers can render "memory.dreaming" rather than the synthetic
// `__plugin_memory_dreaming` global id the scheduler uses internally.
export type CronListSource = { kind: 'user' } | { kind: 'plugin'; pluginName: string; localId: string }

// Display-oriented snapshot of a CronJob, separated from CronJob itself
// so the WS wire shape stays stable as CronJob accretes runtime-only
// fields (scheduledByOrigin, future description, etc.).
export type CronListEntry = {
  id: string
  source: CronListSource
  kind: 'prompt' | 'exec' | 'handler'
  schedule: string | undefined
  at: string | undefined
  until: string | undefined
  count: number | undefined
  timezone: string | undefined
  enabled: boolean
  scheduledByRole: string | undefined
  // null when cron-parser rejects `schedule` — keeps such rows visible
  // in the list with the original error preserved in `scheduleError`,
  // rather than dropping them silently as the scheduler would.
  nextFireMs: number | null
  scheduleError: string | undefined
  prompt: string | undefined
  subagent: string | undefined
  command: readonly string[] | undefined
}

export type AggregateCronListOptions = {
  userJobs: readonly CronJob[]
  // Registered entries (not flat CronJob[]) so each row can be attributed
  // to its plugin + localId without re-parsing the global id.
  pluginJobs: readonly RegisteredCronJob[]
  now: number
  // Durable fire progress for count-limited jobs. Without this, an exhausted
  // count job would render with a future next-fire time and lie about being
  // retired, so the listing threads the same firedCount the scheduler uses.
  firedCount?: (job: CronJob) => number
}

export function aggregateCronList(opts: AggregateCronListOptions): CronListEntry[] {
  const firedCount = opts.firedCount ?? (() => 0)
  const entries: CronListEntry[] = []
  for (const job of opts.userJobs) {
    entries.push(toEntry(job, { kind: 'user' }, opts.now, firedCount(job)))
  }
  for (const reg of opts.pluginJobs) {
    entries.push(
      toEntry(
        reg.job,
        { kind: 'plugin', pluginName: reg.pluginName, localId: reg.localId },
        opts.now,
        firedCount(reg.job),
      ),
    )
  }
  // Sort by next-fire time ascending so the soonest-firing job is at the
  // top. Jobs with a null nextFireMs (parse errors) sort to the bottom
  // so the human-readable list keeps the actionable rows first. Disabled
  // jobs still get a nextFireMs computed — they appear in the list with
  // an "(disabled)" badge but their position reflects when they WOULD
  // have fired had they been enabled.
  entries.sort(compareByNextFire)
  return entries
}

function toEntry(job: CronJob, source: CronListSource, now: number, firedCount: number): CronListEntry {
  const fire = computeNextFire(job, now, { firedCount })
  const base = {
    id: job.id,
    source,
    schedule: job.schedule,
    at: job.at,
    until: job.until,
    count: job.count,
    timezone: job.timezone,
    enabled: job.enabled,
    scheduledByRole: job.scheduledByRole,
    nextFireMs: fire.ok ? fire.nextFire : null,
    scheduleError: fire.ok || fire.expired ? undefined : fire.reason,
  } as const
  if (job.kind === 'prompt') {
    return {
      ...base,
      kind: 'prompt',
      prompt: job.prompt,
      subagent: job.subagent,
      command: undefined,
    }
  }
  if (job.kind === 'exec') {
    return {
      ...base,
      kind: 'exec',
      prompt: undefined,
      subagent: undefined,
      command: job.command,
    }
  }
  // Handler jobs carry a function reference, not a serializable payload.
  // Surface the row so the list stays complete; leave action fields undefined.
  return {
    ...base,
    kind: 'handler',
    prompt: undefined,
    subagent: undefined,
    command: undefined,
  }
}

function compareByNextFire(a: CronListEntry, b: CronListEntry): number {
  if (a.nextFireMs === null && b.nextFireMs === null) return a.id.localeCompare(b.id)
  if (a.nextFireMs === null) return 1
  if (b.nextFireMs === null) return -1
  if (a.nextFireMs !== b.nextFireMs) return a.nextFireMs - b.nextFireMs
  return a.id.localeCompare(b.id)
}
