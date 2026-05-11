import { stop, type StopResult } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'
import type { AgentResult } from './start'

export type StopSuccess = Extract<StopResult, { ok: true }>

export type ComposeStopResult = {
  agents: AgentEntry[]
  results: AgentResult<StopSuccess>[]
}

export async function composeStop(rootCwd: string): Promise<ComposeStopResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<StopSuccess>> => {
      try {
        const data = await stop({ cwd: agent.cwd })
        if (!data.ok) return { name: agent.name, ok: false, reason: data.reason }
        return { name: agent.name, ok: true, data }
      } catch (error) {
        return { name: agent.name, ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
  return { agents, results }
}
