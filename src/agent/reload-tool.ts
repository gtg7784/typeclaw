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
      'Reload all reloadable typeclaw subsystems (currently: cron jobs from cron.json). ' +
      'Validates the on-disk config first; if validation fails, the live state is left unchanged ' +
      'and the failure reason is returned. Use this after editing cron.json so the change takes ' +
      'effect without restarting the container. Safe to call any time.',
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
