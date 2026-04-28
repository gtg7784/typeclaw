import type { Reloadable, ReloadResult } from '@/reload'

import { type ConfigReloadDiff, reloadConfig } from './config'

export type CreateConfigReloadableOptions = {
  cwd: string
}

export function createConfigReloadable({ cwd }: CreateConfigReloadableOptions): Reloadable {
  return {
    scope: 'config',
    description: 'typeclaw.json runtime config',
    reload: async () => doReload(cwd),
  }
}

async function doReload(cwd: string): Promise<ReloadResult> {
  let diff: ConfigReloadDiff
  try {
    diff = reloadConfig(cwd)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { scope: 'config', ok: false, reason: message }
  }

  return {
    scope: 'config',
    ok: true,
    summary: formatSummary(diff),
    details: diff,
  }
}

function formatSummary(diff: ConfigReloadDiff): string {
  return `${diff.applied.length} applied, ${diff.restartRequired.length} restart-required, ${diff.ignored.length} ignored`
}
