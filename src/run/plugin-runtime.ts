import type { Subagent as InternalSubagent, SubagentRegistry } from '@/agent/subagents'
import type { HookBus, MaterializedSkills, PluginRegistry, Subagent as PluginSubagent } from '@/plugin'

export type PluginSubagentEntry = {
  pluginName: string
  subagentName: string
  pluginSubagent: PluginSubagent<any>
}

export type PluginRuntimeState = {
  registry: PluginRegistry
  hooks: HookBus
  subagents: SubagentRegistry
  pluginSubagentByShim: WeakMap<InternalSubagent<any>, PluginSubagentEntry>
  hasAnyPluginContent: boolean
  loadedPlugins: { name: string; version: string | undefined; source: string }[]
  materializedSkills: MaterializedSkills | null
}

export type PluginRuntime = {
  get: () => PluginRuntimeState
  swap: (next: PluginRuntimeState) => PluginRuntimeState
  trackPendingDisposal: (skills: MaterializedSkills) => void
  drainPendingDisposal: () => MaterializedSkills[]
}

export function createPluginRuntime(initial: PluginRuntimeState): PluginRuntime {
  let current = initial
  const pendingDisposal: MaterializedSkills[] = []

  return {
    get: () => current,
    swap: (next) => {
      const prev = current
      current = next
      return prev
    },
    trackPendingDisposal: (skills) => {
      pendingDisposal.push(skills)
    },
    drainPendingDisposal: () => pendingDisposal.splice(0, pendingDisposal.length),
  }
}
