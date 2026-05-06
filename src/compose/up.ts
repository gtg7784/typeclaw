import { validateConfig } from '@/config'
import { start, type StartResult } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'

export type AgentResult<T> = { name: string; ok: true; data: T } | { name: string; ok: false; reason: string }

export type StartSuccess = Extract<StartResult, { ok: true }>

export type ComposeUpOptions = {
  rootCwd: string
  preferredHostPort: number
  forceBuild?: boolean
  cliEntry?: string
}

export type ComposeUpResult = {
  agents: AgentEntry[]
  results: AgentResult<StartSuccess>[]
}

export async function composeUp({
  rootCwd,
  preferredHostPort,
  forceBuild = false,
  cliEntry,
}: ComposeUpOptions): Promise<ComposeUpResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<StartSuccess>> => {
      const validated = validateConfig(agent.cwd)
      if (!validated.ok) return { name: agent.name, ok: false, reason: validated.reason }
      try {
        const data = await start({ cwd: agent.cwd, preferredHostPort, forceBuild, cliEntry })
        if (!data.ok) return { name: agent.name, ok: false, reason: data.reason }
        return { name: agent.name, ok: true, data }
      } catch (error) {
        return { name: agent.name, ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
  return { agents, results }
}
