import { existsSync } from 'node:fs'

import type { CronJob, PromptJob } from '@/cron'

import type { HookBus } from './hooks'
import type {
  PluginCronJob,
  PluginDoctorCheck,
  PluginExports,
  PluginLogger,
  PluginSkill,
  Subagent,
  Tool,
} from './types'

export type RegisteredTool = { pluginName: string; toolName: string; tool: Tool<any>; logger: PluginLogger }
export type RegisteredSubagent = { pluginName: string; subagentName: string; subagent: Subagent<any> }
export type RegisteredCronJob = { pluginName: string; localId: string; globalId: string; job: CronJob }
export type RegisteredSkillEntry = { pluginName: string; localName: string; skill: PluginSkill }
export type RegisteredSkillDir = { pluginName: string; path: string }
export type RegisteredDoctorCheck = {
  pluginName: string
  checkName: string
  pluginConfig: unknown
  logger: PluginLogger
  check: PluginDoctorCheck
}

export type PluginRegistry = {
  tools: RegisteredTool[]
  subagents: RegisteredSubagent[]
  cronJobs: RegisteredCronJob[]
  skills: RegisteredSkillEntry[]
  skillsDirs: RegisteredSkillDir[]
  doctorChecks: RegisteredDoctorCheck[]
}

export type RegisterContributionsOptions = {
  pluginName: string
  logger: PluginLogger
  exports: PluginExports
  registry: PluginRegistry
  hooks: HookBus
  agentDir: string
  pluginConfig: unknown
}

export function buildPluginCronGlobalId(pluginName: string, localId: string): string {
  return `__plugin_${pluginName}_${localId}`
}

export function registerContributions(opts: RegisterContributionsOptions): void {
  const { pluginName, logger, exports: ex, registry, hooks, agentDir, pluginConfig } = opts

  if (ex.tools) {
    for (const [toolName, tool] of Object.entries(ex.tools)) {
      assertNotEmpty('tool name', toolName, pluginName)
      const conflict = registry.tools.find((t) => t.toolName === toolName)
      if (conflict) {
        throw new Error(`plugin ${pluginName}: tool "${toolName}" already registered by plugin ${conflict.pluginName}`)
      }
      registry.tools.push({ pluginName, toolName, tool, logger })
    }
  }

  if (ex.subagents) {
    for (const [subagentName, subagent] of Object.entries(ex.subagents)) {
      assertNotEmpty('subagent name', subagentName, pluginName)
      const conflict = registry.subagents.find((s) => s.subagentName === subagentName)
      if (conflict) {
        throw new Error(
          `plugin ${pluginName}: subagent "${subagentName}" already registered by plugin ${conflict.pluginName}`,
        )
      }
      registry.subagents.push({ pluginName, subagentName, subagent })
    }
  }

  if (ex.cronJobs) {
    for (const [localId, spec] of Object.entries(ex.cronJobs)) {
      assertNotEmpty('cron job id', localId, pluginName)
      const globalId = buildPluginCronGlobalId(pluginName, localId)
      const conflict = registry.cronJobs.find((j) => j.globalId === globalId)
      if (conflict) {
        throw new Error(
          `plugin ${pluginName}: cron job "${localId}" globalId "${globalId}" conflicts with plugin ${conflict.pluginName}`,
        )
      }
      const job = toCronJob(globalId, spec)
      registry.cronJobs.push({ pluginName, localId, globalId, job })
    }
  }

  if (ex.skills) {
    for (const [localName, skill] of Object.entries(ex.skills)) {
      assertNotEmpty('skill name', localName, pluginName)
      const conflict = registry.skills.find((s) => s.localName === localName)
      if (conflict) {
        throw new Error(
          `plugin ${pluginName}: skill "${localName}" already registered by plugin ${conflict.pluginName}`,
        )
      }
      registry.skills.push({ pluginName, localName, skill })
    }
  }

  if (ex.skillsDirs) {
    for (const path of ex.skillsDirs) {
      if (!existsSync(path)) {
        logger.warn(`skillsDirs entry does not exist on disk: ${path}`)
      }
      registry.skillsDirs.push({ pluginName, path })
    }
  }

  if (ex.hooks) {
    hooks.registerAll(pluginName, agentDir, logger, ex.hooks)
  }

  if (ex.doctorChecks) {
    for (const [checkName, check] of Object.entries(ex.doctorChecks)) {
      assertNotEmpty('doctor check name', checkName, pluginName)
      const conflict = registry.doctorChecks.find((c) => c.pluginName === pluginName && c.checkName === checkName)
      if (conflict) {
        throw new Error(`plugin ${pluginName}: doctor check "${checkName}" already registered`)
      }
      registry.doctorChecks.push({ pluginName, checkName, pluginConfig, logger, check })
    }
  }
}

export function discardRegistrationsBy(pluginName: string, registry: PluginRegistry, hooks: HookBus): void {
  registry.tools = registry.tools.filter((t) => t.pluginName !== pluginName)
  registry.subagents = registry.subagents.filter((s) => s.pluginName !== pluginName)
  registry.cronJobs = registry.cronJobs.filter((j) => j.pluginName !== pluginName)
  registry.skills = registry.skills.filter((s) => s.pluginName !== pluginName)
  registry.skillsDirs = registry.skillsDirs.filter((d) => d.pluginName !== pluginName)
  registry.doctorChecks = registry.doctorChecks.filter((d) => d.pluginName !== pluginName)
  hooks.unregisterAll(pluginName)
}

export function emptyRegistry(): PluginRegistry {
  return { tools: [], subagents: [], cronJobs: [], skills: [], skillsDirs: [], doctorChecks: [] }
}

function assertNotEmpty(kind: string, value: string, pluginName: string): void {
  if (value.length === 0) {
    throw new Error(`plugin ${pluginName}: empty ${kind}`)
  }
}

function toCronJob(globalId: string, spec: PluginCronJob): CronJob {
  if (spec.kind === 'prompt') {
    const job: PromptJob = {
      id: globalId,
      schedule: spec.schedule,
      enabled: spec.enabled ?? true,
      kind: 'prompt',
      prompt: spec.prompt,
      ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
      ...(spec.subagent !== undefined ? { subagent: spec.subagent } : {}),
      ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
    }
    return job
  }
  return {
    id: globalId,
    schedule: spec.schedule,
    enabled: spec.enabled ?? true,
    kind: 'exec',
    command: spec.command,
    ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
  }
}
