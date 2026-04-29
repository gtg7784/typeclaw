import type { SubagentRegistry } from '@/agent/subagents'
import type { Reloadable, ReloadResult } from '@/reload'

import { loadCron } from './index'
import type { JobDiff, Scheduler } from './scheduler'
import type { CronJob } from './schema'

export type CreateCronReloadableOptions = {
  cwd: string
  scheduler: Scheduler
  // Internal jobs (e.g. dreaming) survive cron.json reloads. The reloadable
  // recomputes them on every reload so config-driven changes propagate too.
  internalJobs?: () => CronJob[]
  // Resolved per reload so plugin reloads (registered earlier) are visible
  // when cron re-validates job.subagent references.
  getSubagents?: () => SubagentRegistry
}

export function createCronReloadable({
  cwd,
  scheduler,
  internalJobs,
  getSubagents,
}: CreateCronReloadableOptions): Reloadable {
  return {
    scope: 'cron',
    description: 'cron jobs from cron.json',
    reload: async () => doReload({ cwd, scheduler, internalJobs, getSubagents }),
  }
}

async function doReload({
  cwd,
  scheduler,
  internalJobs,
  getSubagents,
}: CreateCronReloadableOptions): Promise<ReloadResult> {
  const subagents = getSubagents?.()
  const loaded = await loadCron(cwd, subagents !== undefined ? { subagents } : {})
  if (!loaded.ok) {
    return { scope: 'cron', ok: false, reason: loaded.reason }
  }
  const userJobs = loaded.file?.jobs ?? []
  const nextJobs: CronJob[] = [...userJobs, ...(internalJobs?.() ?? [])]

  let diff: JobDiff
  try {
    diff = scheduler.replaceJobs(nextJobs)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { scope: 'cron', ok: false, reason: `apply failed (schedule unchanged): ${message}` }
  }

  return {
    scope: 'cron',
    ok: true,
    summary: formatSummary(diff, nextJobs.length),
    details: diff,
  }
}

function formatSummary(diff: JobDiff, total: number): string {
  return `${total} jobs (added ${diff.added.length}, removed ${diff.removed.length}, updated ${diff.updated.length}, unchanged ${diff.unchanged.length})`
}
