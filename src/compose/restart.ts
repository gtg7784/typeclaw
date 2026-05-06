import { validateConfig } from '@/config'
import { start, stop } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'
import type { StopSuccess } from './down'
import type { AgentResult, StartSuccess } from './up'

export type RestartData = { stop: StopSuccess; start: StartSuccess }

export type ComposeRestartOptions = {
  rootCwd: string
  preferredHostPort: number
  forceBuild?: boolean
  cliEntry?: string
}

export type ComposeRestartResult = {
  agents: AgentEntry[]
  results: AgentResult<RestartData>[]
}

export async function composeRestart({
  rootCwd,
  preferredHostPort,
  forceBuild = false,
  cliEntry,
}: ComposeRestartOptions): Promise<ComposeRestartResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<RestartData>> => {
      const validated = validateConfig(agent.cwd)
      if (!validated.ok) return { name: agent.name, ok: false, reason: validated.reason }
      try {
        const stopped = await stop({ cwd: agent.cwd })
        if (!stopped.ok) return { name: agent.name, ok: false, reason: stopped.reason }
        const started = await start({ cwd: agent.cwd, preferredHostPort, forceBuild, cliEntry })
        if (!started.ok) return { name: agent.name, ok: false, reason: started.reason }
        return { name: agent.name, ok: true, data: { stop: stopped, start: started } }
      } catch (error) {
        return { name: agent.name, ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
  return { agents, results }
}
