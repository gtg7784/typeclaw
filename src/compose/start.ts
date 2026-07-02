import { validateConfig } from '@/config'
import { LocalDockerController, type StartResult } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'

export type AgentResult<T> =
  | { name: string; ok: true; data: T; warnings?: string[] }
  | { name: string; ok: false; reason: string }

export type StartSuccess = Extract<StartResult, { ok: true }>

export type ComposeStartEvent =
  | { kind: 'agent-start'; name: string }
  | { kind: 'agent-done'; name: string; result: AgentResult<StartSuccess> }

export type ComposeStartOptions = {
  rootCwd: string
  preferredHostPort: number
  forceBuild?: boolean
  cliEntry?: string
  onProgress?: (event: ComposeStartEvent) => void
}

export type ComposeStartResult = {
  agents: AgentEntry[]
  results: AgentResult<StartSuccess>[]
}

export async function composeStart({
  rootCwd,
  preferredHostPort,
  forceBuild = false,
  cliEntry,
  onProgress,
}: ComposeStartOptions): Promise<ComposeStartResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<StartSuccess>> => {
      onProgress?.({ kind: 'agent-start', name: agent.name })
      const result = await runOne(agent.name, agent.cwd, preferredHostPort, forceBuild, cliEntry)
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
): Promise<AgentResult<StartSuccess>> {
  const validated = validateConfig(cwd)
  if (!validated.ok) return { name, ok: false, reason: validated.reason }
  try {
    const data = await new LocalDockerController().start({ cwd, preferredHostPort, forceBuild, cliEntry })
    if (!data.ok) return { name, ok: false, reason: data.reason }
    return { name, ok: true, data, warnings: validated.warnings }
  } catch (error) {
    return { name, ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
