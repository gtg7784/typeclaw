import type { Reloadable, ReloadResult } from '@/reload'

import { loadCron } from './index'
import type { JobDiff, Scheduler } from './scheduler'

export type CreateCronReloadableOptions = {
  cwd: string
  scheduler: Scheduler
}

export function createCronReloadable({ cwd, scheduler }: CreateCronReloadableOptions): Reloadable {
  return {
    scope: 'cron',
    description: 'cron jobs from cron.json',
    reload: async () => doReload({ cwd, scheduler }),
  }
}

async function doReload({ cwd, scheduler }: CreateCronReloadableOptions): Promise<ReloadResult> {
  const loaded = await loadCron(cwd)
  if (!loaded.ok) {
    return { scope: 'cron', ok: false, reason: loaded.reason }
  }
  const nextJobs = loaded.file?.jobs ?? []

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
