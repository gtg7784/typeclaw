import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentSession, DefaultResourceLoader, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession, ToolDefinition } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
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
import { renderGitNudge } from './git-nudge'
import { resolveBuiltinToolRefs, wrapPluginTool } from './plugin-tools'
import { createReloadTool } from './reload-tool'
import { loadSelf } from './self'
import { renderSessionOrigin, type SessionOrigin } from './session-origin'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'
import { createChannelHistoryTool } from './tools/channel-history'
import { createChannelReplyTool } from './tools/channel-reply'
import { createChannelSendTool } from './tools/channel-send'
import { createRestartTool } from './tools/restart'
import { createStreamSnapshotTool } from './tools/stream-snapshot'
import { webfetchTool } from './tools/webfetch'
import { websearchTool } from './tools/websearch'

export type { SessionOrigin } from './session-origin'

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
  channelRouter?: ChannelRouter
  // Bypass the file-based resource loader (IDENTITY.md, SOUL.md, MEMORY.md,
  // memory/, bundled skills) and use this string verbatim as the system prompt.
  systemPromptOverride?: string
  // Identifies the kind of session and (for channels) its addressing fields.
  // Rendered into the system prompt so the agent knows who's listening, where
  // its output goes, and what to pass to channel_send.
  origin?: SessionOrigin
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
  plugins?: PluginSessionWiring
  // When set, only the named plugin subagent's own tools are exposed; the
  // wider plugin registry's tools are NOT injected. Used by plugin subagent
  // session creation so subagents see exactly what they declared.
  pluginSubagent?: PluginSubagentSelection
  // Enables the `restart` tool. Set when the agent is running inside a
  // typeclaw-managed container and the host daemon is reachable via the
  // bind-mounted run dir. Read from TYPECLAW_CONTAINER_NAME at the call site.
  containerName?: string
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
      ? await createOverrideResourceLoader(options.systemPromptOverride, options.origin)
      : await createResourceLoader({
          ...(options.plugins ? { plugins: options.plugins, materializedSkills } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
        })

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
            ...buildChannelTools(options.channelRouter, options.origin),
            ...(options.containerName ? [createRestartTool({ containerName: options.containerName })] : []),
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

// Builds the channel tool subset: channel_send (always when a router is
// available), plus channel_reply + channel_history (only when the session
// origin is a channel — those rely on origin-bound addressing). Extracted
// from createSessionWithDispose so composition can be unit-tested without
// going through createAgentSession / auth.
export function buildChannelTools(
  channelRouter: ChannelRouter | undefined,
  origin: SessionOrigin | undefined,
): ToolDefinition[] {
  if (!channelRouter) return []
  const tools: ToolDefinition[] = []
  if (origin?.kind === 'channel') {
    const channelOrigin = {
      adapter: origin.adapter,
      workspace: origin.workspace,
      chat: origin.chat,
      thread: origin.thread,
    }
    tools.push(createChannelReplyTool({ router: channelRouter, origin: channelOrigin }))
    tools.push(createChannelHistoryTool({ router: channelRouter, origin: channelOrigin }))
    tools.push(createChannelSendTool({ router: channelRouter, origin: channelOrigin }))
  } else {
    tools.push(createChannelSendTool({ router: channelRouter }))
  }
  return tools
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

export async function createOverrideResourceLoader(
  systemPrompt: string,
  origin?: SessionOrigin,
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => withOrigin(systemPrompt, origin),
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  return loader
}

export type CreateResourceLoaderOptions = {
  agentDir?: string
  plugins?: PluginSessionWiring
  materializedSkills?: MaterializedSkills | null
  origin?: SessionOrigin
}

export async function createResourceLoader(options: CreateResourceLoaderOptions = {}): Promise<DefaultResourceLoader> {
  const agentDir = options.agentDir ?? process.cwd()
  const self = await loadSelf(agentDir)
  let systemPrompt = `${DEFAULT_SYSTEM_PROMPT}\n\n${self}`

  if (options.plugins) {
    const event = { prompt: systemPrompt, sessionId: options.plugins.sessionId, agentDir }
    await options.plugins.hooks.runSessionPrompt(event)
    systemPrompt = event.prompt
  }

  // Appended last so the dirty-files snapshot is the most-recent context the
  // agent reads, and so its bytes sit in the cache-suffix region rather than
  // splitting the cacheable prefix shared by clean-worktree sessions.
  const gitNudge = await renderGitNudge(agentDir)
  if (gitNudge !== '') {
    systemPrompt = `${systemPrompt}\n\n${gitNudge}`
  }

  const additionalSkillPaths = [getBundledSkillsDir()]
  // pi-coding-agent's DefaultResourceLoader auto-discovers <agentDir>/skills/
  // but not <agentDir>/.agents/skills/. We do not scaffold <agentDir>/skills/
  // and the system prompt no longer advertises it — the only skill directories
  // a TypeClaw agent owns are .agents/skills/ (user-installed) and
  // memory/skills/ (dreaming-owned). Both are wired in explicitly below;
  // anything the upstream loader auto-discovers under <agentDir>/skills/ is
  // outside our supported surface.
  const userInstalledSkillsDir = join(agentDir, '.agents', 'skills')
  if (existsSync(userInstalledSkillsDir)) {
    additionalSkillPaths.push(userInstalledSkillsDir)
  }
  // Muscle-memory skills written by the dreaming subagent. Same auto-discover
  // story as `.agents/skills/` — the loader doesn't walk arbitrary subtrees of
  // the agent dir, so we wire this in explicitly. Existence-gated so a session
  // that has never dreamed doesn't pay for an empty path.
  const muscleMemorySkillsDir = join(agentDir, 'memory', 'skills')
  if (existsSync(muscleMemorySkillsDir)) {
    additionalSkillPaths.push(muscleMemorySkillsDir)
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
    systemPromptOverride: () => withOrigin(systemPrompt, options.origin),
    appendSystemPromptOverride: () => [],
    additionalSkillPaths,
  })
  await loader.reload()
  return loader
}

function withOrigin(systemPrompt: string, origin: SessionOrigin | undefined): string {
  if (!origin) return systemPrompt
  return `${systemPrompt}\n\n${renderSessionOrigin(origin)}`
}

export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}
