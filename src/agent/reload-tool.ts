import { defineTool } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

import type { ReloadRegistry, ReloadResult } from '@/reload'

export type CreateReloadToolOptions = {
  registry: ReloadRegistry
}

export function createReloadTool({ registry }: CreateReloadToolOptions) {
  return defineTool({
    name: 'reload',
    label: 'Reload',
    description:
      'Reload all reloadable typeclaw subsystems (currently: typeclaw.json runtime config, then ' +
      'cron jobs from cron.json — runs serially in registration order so cron observes the ' +
      'freshly-swapped config). Validates each on-disk file first; if validation fails for one, ' +
      'its live state is left unchanged and the failure reason is reported in that scope\'s ' +
      'result. Boot-only fields (port, mounts, memory.idleMs) are reported as restart-required. ' +
      'Use this after editing typeclaw.json or cron.json so the change takes effect without ' +
      'restarting the container. Safe to call any time.',
    parameters: Type.Object({}),
    execute: async () => {
      const items = registry.list()
      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: 'nothing to reload (no reloadable subsystems registered)' }],
          details: { results: [] },
        }
      }

      const { results } = await registry.reloadAll()
      return {
        content: [{ type: 'text', text: formatResults(results) }],
        details: { results },
      }
    },
  })
}

function formatResults(results: ReloadResult[]): string {
  const lines = results.map((r) => {
    if (r.ok) return `[${r.scope}] ok: ${r.summary}`
    return `[${r.scope}] failed: ${r.reason}`
  })
  const failedCount = results.filter((r) => !r.ok).length
  const header =
    failedCount === 0
      ? `Reloaded ${results.length} subsystem(s).`
      : `Reloaded ${results.length} subsystem(s); ${failedCount} failed.`
  return [header, ...lines].join('\n')
}
