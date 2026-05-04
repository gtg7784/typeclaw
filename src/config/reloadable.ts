import type { Reloadable, ReloadResult } from '@/reload'

import { type ConfigReloadDiff, reloadConfig, validateConfig } from './config'

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
  // Mount accessibility belongs to the validation surface, not loadConfigSync —
  // validateConfig is the single gate that every host-side caller goes through.
  // Run it before swapping the live config pointer so a mount that vanished
  // between starts surfaces as a reload failure (`mounts` is restart-required
  // anyway, so the user has to restart to pick up changes; better to flag the
  // problem now than to let restart fail later).
  const validated = validateConfig(cwd)
  if (!validated.ok) {
    return { scope: 'config', ok: false, reason: validated.reason }
  }

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
