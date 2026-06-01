import type { ReloadResult } from './types'

// Human-facing /reload reply for Slack/Discord. Separate from reload-tool.ts's
// model-facing formatter on purpose — different audience, different shape.
export function formatChannelReloadSummary(results: readonly ReloadResult[]): string {
  if (results.length === 0) return 'Nothing to reload.'
  const failed = results.filter((r) => !r.ok).length
  const header =
    failed === 0
      ? `Reloaded ${results.length} subsystem(s).`
      : `Reloaded ${results.length} subsystem(s); ${failed} failed.`
  const lines = results.map((r) => (r.ok ? `• ${r.scope}: ${r.summary}` : `• ${r.scope}: failed — ${r.reason}`))
  return [header, ...lines].join('\n')
}
