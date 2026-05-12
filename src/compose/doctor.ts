import { loadConfigSync } from '@/config'
import { runDoctor, type DoctorRunResult, type RunDoctorOptions } from '@/doctor'

import { discoverAgents, type AgentEntry } from './discover'

export type ComposeDoctorAgent = {
  entry: AgentEntry
  result: DoctorRunResult
}

export type ComposeDoctorCrossCheck = {
  name: string
  status: 'ok' | 'warning' | 'error' | 'info'
  message: string
  details?: string[]
}

export type ComposeDoctorReport = {
  rootCwd: string
  agents: ComposeDoctorAgent[]
  crossChecks: ComposeDoctorCrossCheck[]
  ok: boolean
}

export type ComposeDoctorOptions = {
  rootCwd: string
  fix?: boolean
  only?: string[]
  shallow?: boolean
  runDoctorFn?: (opts: RunDoctorOptions) => Promise<DoctorRunResult>
}

export async function composeDoctor(opts: ComposeDoctorOptions): Promise<ComposeDoctorReport> {
  const runDoctorFn = opts.runDoctorFn ?? runDoctor
  const agents = discoverAgents(opts.rootCwd)

  const crossChecks: ComposeDoctorCrossCheck[] = []
  if (agents.length === 0) {
    crossChecks.push({
      name: 'compose.root-has-agents',
      status: 'info',
      message: 'no typeclaw agents found in immediate subdirectories',
    })
  } else {
    crossChecks.push(...runCrossChecks(agents))
  }

  let agentResults: ComposeDoctorAgent[] = []
  if (!opts.shallow) {
    agentResults = await Promise.all(
      agents.map(async (entry) => ({
        entry,
        result: await runDoctorFn({
          cwd: entry.cwd,
          ...(opts.fix === true ? { fix: true } : {}),
          ...(opts.only !== undefined ? { only: opts.only } : {}),
        }),
      })),
    )
  }

  const ok =
    crossChecks.every((c) => c.status === 'ok' || c.status === 'info') &&
    agentResults.every((a) => (a.result.final ?? a.result.initial).ok)

  return { rootCwd: opts.rootCwd, agents: agentResults, crossChecks, ok }
}

export function runCrossChecks(agents: AgentEntry[]): ComposeDoctorCrossCheck[] {
  const checks: ComposeDoctorCrossCheck[] = []

  const portConfigs = collectPreferredPorts(agents)
  const portDuplicates = findDuplicates(portConfigs.map(({ port }) => port))
  if (portDuplicates.size === 0) {
    checks.push({
      name: 'compose.no-port-collisions',
      status: 'ok',
      message: `${portConfigs.length} agent(s) declare unique preferred ports`,
    })
  } else {
    const details = [...portDuplicates].map((port) => {
      const names = portConfigs.filter((p) => p.port === port).map((p) => p.name)
      return `port ${port}: ${names.join(', ')}`
    })
    checks.push({
      name: 'compose.no-port-collisions',
      status: 'warning',
      message: `${portDuplicates.size} preferred port(s) shared across agents`,
      details,
    })
  }

  const nameDuplicates = findDuplicates(agents.map((a) => a.containerName))
  if (nameDuplicates.size === 0) {
    checks.push({
      name: 'compose.no-container-name-collisions',
      status: 'ok',
      message: 'all agent folders map to unique Docker names',
    })
  } else {
    const details = [...nameDuplicates].map((name) => {
      const collisions = agents.filter((a) => a.containerName === name).map((a) => a.name)
      return `${name}: ${collisions.join(', ')}`
    })
    checks.push({
      name: 'compose.no-container-name-collisions',
      status: 'error',
      message: `${nameDuplicates.size} container name(s) shared across agents`,
      details,
    })
  }

  return checks
}

function collectPreferredPorts(agents: AgentEntry[]): Array<{ name: string; port: number }> {
  const out: Array<{ name: string; port: number }> = []
  for (const agent of agents) {
    const port = readPreferredPort(agent.cwd)
    if (port !== null) out.push({ name: agent.name, port })
  }
  return out
}

function readPreferredPort(cwd: string): number | null {
  try {
    return loadConfigSync(cwd).port
  } catch {
    return null
  }
}

function findDuplicates<T>(items: T[]): Set<T> {
  const seen = new Set<T>()
  const dupes = new Set<T>()
  for (const item of items) {
    if (seen.has(item)) dupes.add(item)
    else seen.add(item)
  }
  return dupes
}
