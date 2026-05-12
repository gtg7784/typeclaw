import { validateConfig } from '@/config'
import { start, stop } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'
import type { AgentResult, StartSuccess } from './start'
import type { StopSuccess } from './stop'

export type RestartData = { stop: StopSuccess; start: StartSuccess }

export type ComposeRestartEvent =
  | { kind: 'agent-start'; name: string }
  | { kind: 'agent-stopped'; name: string }
  | { kind: 'agent-done'; name: string; result: AgentResult<RestartData> }

export type ComposeRestartOptions = {
  rootCwd: string
  preferredHostPort: number
  forceBuild?: boolean
  cliEntry?: string
  onProgress?: (event: ComposeRestartEvent) => void
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
  onProgress,
}: ComposeRestartOptions): Promise<ComposeRestartResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<RestartData>> => {
      onProgress?.({ kind: 'agent-start', name: agent.name })
      const result = await runOne(agent.name, agent.cwd, preferredHostPort, forceBuild, cliEntry, () => {
        onProgress?.({ kind: 'agent-stopped', name: agent.name })
      })
      onProgress?.({ kind: 'agent-done', name: agent.name, result })
      return result
    }),
  )
  return { agents, results }
}

async function runOne(
  name: string,
  cwd: string,
  preferredHostPort: number,
  forceBuild: boolean,
  cliEntry: string | undefined,
  onStopped: () => void,
): Promise<AgentResult<RestartData>> {
  const validated = validateConfig(cwd)
  if (!validated.ok) return { name, ok: false, reason: validated.reason }
  try {
    const stopped = await stop({ cwd })
    if (!stopped.ok) return { name, ok: false, reason: stopped.reason }
    onStopped()
    const started = await start({ cwd, preferredHostPort, forceBuild, cliEntry })
    if (!started.ok) return { name, ok: false, reason: started.reason }
    return { name, ok: true, data: { stop: stopped, start: started } }
  } catch (error) {
    return { name, ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
