import { LocalDockerController, type StopResult } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'
import type { AgentResult } from './start'

export type StopSuccess = Extract<StopResult, { ok: true }>

export type ComposeStopEvent =
  | { kind: 'agent-start'; name: string }
  | { kind: 'agent-done'; name: string; result: AgentResult<StopSuccess> }

export type ComposeStopOptions = {
  rootCwd: string
  onProgress?: (event: ComposeStopEvent) => void
}

export type ComposeStopResult = {
  agents: AgentEntry[]
  results: AgentResult<StopSuccess>[]
}

export async function composeStop({ rootCwd, onProgress }: ComposeStopOptions): Promise<ComposeStopResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<StopSuccess>> => {
      onProgress?.({ kind: 'agent-start', name: agent.name })
      const result = await runOne(agent.name, agent.cwd)
      onProgress?.({ kind: 'agent-done', name: agent.name, result })
      return result
    }),
  )
  return { agents, results }
}

async function runOne(name: string, cwd: string): Promise<AgentResult<StopSuccess>> {
  try {
    const data = await new LocalDockerController().stop({ cwd })
    if (!data.ok) return { name, ok: false, reason: data.reason }
    return { name, ok: true, data }
  } catch (error) {
    return { name, ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
