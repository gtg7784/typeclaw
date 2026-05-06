import { inspectContainer } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'

export type AgentStatus = 'running' | 'stopped' | 'absent'

export type AgentStatusEntry = AgentEntry & {
  status: AgentStatus
}

export type ComposePsResult = {
  entries: AgentStatusEntry[]
}

export async function composePs(rootCwd: string): Promise<ComposePsResult> {
  const agents = discoverAgents(rootCwd)
  const entries = await Promise.all(
    agents.map(async (agent): Promise<AgentStatusEntry> => {
      const state = await inspectContainer(agent.containerName)
      const status: AgentStatus = !state.exists ? 'absent' : state.running ? 'running' : 'stopped'
      return { ...agent, status }
    }),
  )
  return { entries }
}
