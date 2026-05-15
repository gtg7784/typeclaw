import { runUsage, type UsageReport } from '@/usage'

import { discoverAgents, type AgentEntry } from './discover'
import type { AgentResult } from './start'

export type ComposeUsageEvent =
  | { kind: 'agent-start'; name: string }
  | { kind: 'agent-done'; name: string; result: AgentResult<UsageReport> }

export type ComposeUsageOptions = {
  rootCwd: string
  since?: number
  until?: number
  onProgress?: (event: ComposeUsageEvent) => void
}

export type ComposeUsageResult = {
  rootCwd: string
  range: { since: number | null; until: number | null }
  agents: AgentEntry[]
  results: AgentResult<UsageReport>[]
}

// Fans out `runUsage` across every typeclaw agent in `rootCwd`'s immediate
// subdirectories. Per-agent failures are captured as `AgentResult` rather than
// thrown — one corrupt sessions/ dir shouldn't blank out the whole report.
export async function composeUsage({
  rootCwd,
  since,
  until,
  onProgress,
}: ComposeUsageOptions): Promise<ComposeUsageResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<UsageReport>> => {
      onProgress?.({ kind: 'agent-start', name: agent.name })
      const result = await runOne(agent, since, until)
      onProgress?.({ kind: 'agent-done', name: agent.name, result })
      return result
    }),
  )
  return {
    rootCwd,
    range: { since: since ?? null, until: until ?? null },
    agents,
    results,
  }
}

async function runOne(
  agent: AgentEntry,
  since: number | undefined,
  until: number | undefined,
): Promise<AgentResult<UsageReport>> {
  try {
    const report = await runUsage({
      agentDir: agent.cwd,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    })
    return { name: agent.name, ok: true, data: report }
  } catch (error) {
    return { name: agent.name, ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
