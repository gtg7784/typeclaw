import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentSession, DefaultResourceLoader, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession, ToolDefinition } from '@mariozechner/pi-coding-agent'

import { getConfig, resolveModel } from '@/config'
import type {
  BuiltinToolRef,
  HookBus,
  MaterializedSkills,
  PluginRegistry,
  RegisteredTool as PluginRegisteredTool,
  Tool as PluginTool,
} from '@/plugin'
import { materializeSkills } from '@/plugin'
import type { ReloadRegistry } from '@/reload'
import type { Stream } from '@/stream'

import { getAuth } from './auth'
import { loadMemory } from './memory'
import { resolveBuiltinToolRefs, wrapPluginTool } from './plugin-tools'
import { createReloadTool } from './reload-tool'
import { loadSelf } from './self'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'
import { createStreamSnapshotTool } from './tools/stream-snapshot'
import { webfetchTool } from './tools/webfetch'
import { websearchTool } from './tools/websearch'

export type { AgentSession }

type AgentSessionTools = NonNullable<Parameters<typeof createAgentSession>[0]>['tools']

export type PluginSessionWiring = {
  registry: PluginRegistry
  hooks: HookBus
  sessionId: string
  agentDir: string
}

export type PluginSubagentSelection = {
  pluginName: string
  toolRefs?: BuiltinToolRef[]
  customTools?: PluginTool<any>[]
  toolNamePrefix: string
}

export type CreateSessionOptions = {
  reloadRegistry?: ReloadRegistry
  sessionManager?: SessionManager
  stream?: Stream
  // Bypass the file-based resource loader (IDENTITY.md, SOUL.md, MEMORY.md,
  // memory/, bundled skills) and use this string verbatim as the system prompt.
  systemPromptOverride?: string
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
  plugins?: PluginSessionWiring
  // When set, only the named plugin subagent's own tools are exposed; the
  // wider plugin registry's tools are NOT injected. Used by plugin subagent
  // session creation so subagents see exactly what they declared.
  pluginSubagent?: PluginSubagentSelection
}

export type CreateSessionResult = {
  session: AgentSession
  dispose: () => Promise<void>
}

export async function createSession(options: CreateSessionOptions = {}): Promise<AgentSession> {
  const { session } = await createSessionWithDispose(options)
  return session
}

export async function createSessionWithDispose(options: CreateSessionOptions = {}): Promise<CreateSessionResult> {
  const { authStorage, modelRegistry } = getAuth()

  const materializedSkills =
    options.plugins && options.plugins.registry.skills.length > 0
      ? await materializeSkills(
          options.plugins.registry.skills.map((s) => ({
            pluginName: s.pluginName,
            localName: s.localName,
            skill: s.skill,
          })),
        )
      : null

  const resourceLoader =
    options.systemPromptOverride !== undefined
      ? await createOverrideResourceLoader(options.systemPromptOverride)
      : await createResourceLoader(options.plugins ? { plugins: options.plugins, materializedSkills } : {})

  const subagentBuiltinTools = options.pluginSubagent?.toolRefs
    ? resolveBuiltinToolRefs(options.pluginSubagent.toolRefs)
    : undefined
  const pluginCustomTools = options.pluginSubagent
    ? wrapSubagentCustomTools(options.pluginSubagent, options.plugins)
    : wrapRegistryTools(options.plugins)

  const tools = options.tools ?? (subagentBuiltinTools as AgentSessionTools | undefined)

  const customTools =
    options.customTools !== undefined
      ? [...options.customTools, ...pluginCustomTools]
      : options.pluginSubagent
        ? pluginCustomTools
        : [
            websearchTool,
            webfetchTool,
            ...(options.reloadRegistry ? [createReloadTool({ registry: options.reloadRegistry })] : []),
            ...(options.stream ? [createStreamSnapshotTool({ stream: options.stream })] : []),
            ...pluginCustomTools,
          ]

  const { session } = await createAgentSession({
    model: resolveModel(getConfig().model),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader,
    ...(tools ? { tools } : {}),
    customTools,
  })

  const dispose = async () => {
    if (materializedSkills) await materializedSkills.dispose()
  }
  return { session, dispose }
}

function wrapRegistryTools(plugins: PluginSessionWiring | undefined): ToolDefinition[] {
  if (!plugins) return []
  return plugins.registry.tools.map((t: PluginRegisteredTool) =>
    wrapPluginTool(t.tool, {
      pluginName: t.pluginName,
      toolName: t.toolName,
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      logger: t.logger,
      hooks: plugins.hooks,
    }),
  )
}

function wrapSubagentCustomTools(
  selection: PluginSubagentSelection,
  plugins: PluginSessionWiring | undefined,
): ToolDefinition[] {
  if (!selection.customTools || !plugins) return []
  const logger = makePluginLogger(selection.pluginName)
  return selection.customTools.map((tool, i) =>
    wrapPluginTool(tool, {
      pluginName: selection.pluginName,
      toolName: `${selection.toolNamePrefix}_${i}`,
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      logger,
      hooks: plugins.hooks,
    }),
  )
}

function makePluginLogger(pluginName: string) {
  const prefix = `[plugin:${pluginName}]`
  return {
    info: (m: string) => console.log(`${prefix} ${m}`),
    warn: (m: string) => console.warn(`${prefix} ${m}`),
    error: (m: string) => console.error(`${prefix} ${m}`),
  }
}

export async function createOverrideResourceLoader(systemPrompt: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  return loader
}

export type CreateResourceLoaderOptions = {
  agentDir?: string
  plugins?: PluginSessionWiring
  materializedSkills?: MaterializedSkills | null
}

export async function createResourceLoader(options: CreateResourceLoaderOptions = {}): Promise<DefaultResourceLoader> {
  const agentDir = options.agentDir ?? process.cwd()
  const [self, memory] = await Promise.all([loadSelf(agentDir), loadMemory(agentDir)])
  let systemPrompt = `${DEFAULT_SYSTEM_PROMPT}\n\n${self}\n\n${memory}`

  if (options.plugins) {
    const event = { prompt: systemPrompt, sessionId: options.plugins.sessionId, agentDir }
    await options.plugins.hooks.runSessionPrompt(event)
    systemPrompt = event.prompt
  }

  const additionalSkillPaths = [getBundledSkillsDir()]
  // pi-coding-agent's DefaultResourceLoader auto-discovers <agentDir>/skills/
  // but not <agentDir>/.agents/skills/, even though the system prompt advertises
  // both. Add the user-installed location explicitly so a fresh SKILL.md drop
  // is picked up the next time a session is created.
  const userInstalledSkillsDir = join(agentDir, '.agents', 'skills')
  if (existsSync(userInstalledSkillsDir)) {
    additionalSkillPaths.push(userInstalledSkillsDir)
  }
  if (options.plugins) {
    for (const dir of options.plugins.registry.skillsDirs) {
      additionalSkillPaths.push(dir.path)
    }
  }
  if (options.materializedSkills) {
    additionalSkillPaths.push(options.materializedSkills.dir)
  }

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalSkillPaths,
  })
  await loader.reload()
  return loader
}

export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}
