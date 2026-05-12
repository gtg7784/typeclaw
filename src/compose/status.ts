import { inspectContainer, resolveHostPort } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'

export type AgentRuntimeState = 'running' | 'stopped' | 'absent'

export type AgentStatusEntry = AgentEntry & {
  state: AgentRuntimeState
  hostPort: number | null
}

export type ComposeStatusResult = {
  rootCwd: string
  entries: AgentStatusEntry[]
}

export async function composeStatus(rootCwd: string): Promise<ComposeStatusResult> {
  const agents = discoverAgents(rootCwd)
  const entries = await Promise.all(
    agents.map(async (agent): Promise<AgentStatusEntry> => {
      const container = await inspectContainer(agent.containerName)
      const state: AgentRuntimeState = !container.exists ? 'absent' : container.running ? 'running' : 'stopped'
      const hostPort = state === 'running' ? await resolveHostPort({ cwd: agent.cwd }).catch(() => null) : null
      return { ...agent, state, hostPort }
    }),
  )
  return { rootCwd, entries }
}
