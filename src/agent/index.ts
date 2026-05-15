import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentSession, DefaultResourceLoader, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession, ToolDefinition } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import { getConfig, resolveModel } from '@/config'
import type { PermissionService } from '@/permissions'
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
import { createCompactionSettingsManager } from './compaction'
import { renderGitNudge } from './git-nudge'
import { resolveBuiltinToolRefs, wrapPluginTool, wrapSystemAgentTool, wrapSystemTool } from './plugin-tools'
import { createReloadTool } from './reload-tool'
import { loadSelf } from './self'
import { renderSessionOrigin, type SessionOrigin, type SessionRoleContext } from './session-origin'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'
import { createChannelFetchAttachmentTool } from './tools/channel-fetch-attachment'
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

// Mutable holder for the live session origin. Pass this when the origin
// must be updated turn-by-turn after session creation (channel sessions
// whose `lastInboundAuthorId` changes with each inbound message). Tool
// wrappers read `.current` at execute time, not at wrap time, so the
// `tool.before` event carries the per-turn actor identity rather than the
// stale session-creation snapshot. Sessions that never mutate origin
// (TUI, cron, subagent) can omit it and pass `origin` instead.
export type SessionOriginRef = { current: SessionOrigin | undefined }

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
  // Live origin holder. When provided, the tool wrappers read this at execute
  // time so `tool.before` events see the current-turn origin. Caller is
  // responsible for keeping `.current` up to date. If both `origin` and
  // `originRef` are passed, the ref wins for tool stamping; the static
  // `origin` still drives the initial system-prompt rendering and channel
  // tool addressing (those are only valid at session-creation time).
  originRef?: SessionOriginRef
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
  plugins?: PluginSessionWiring
  // When set, only the named plugin subagent's own tools are exposed; the
  // wider plugin registry's tools are NOT injected. Used by plugin subagent
  // session creation so subagents see exactly what they declared.
  pluginSubagent?: PluginSubagentSelection
  // Enables the `restart` tool. Set when the agent is running inside a
  // typeclaw-managed container. Read from TYPECLAW_CONTAINER_NAME at the call site.
  containerName?: string
  // The permission service the runtime resolved at boot. When provided, the
  // resolved role and permission list for `options.origin` (or
  // `options.originRef.current` at creation time) are rendered into the
  // system prompt under `## Your role in this session` for non-TUI sessions.
  // Omitting it falls back to the previous behavior (no role annotation),
  // which is what tests and stand-alone callers want.
  permissions?: PermissionService
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
      ? await createOverrideResourceLoader(options.systemPromptOverride, options.origin, options.permissions)
      : await createResourceLoader({
          ...(options.plugins ? { plugins: options.plugins, materializedSkills } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.permissions ? { permissions: options.permissions } : {}),
        })

  const getOrigin: () => SessionOrigin | undefined =
    options.originRef !== undefined ? () => options.originRef!.current : () => options.origin

  const subagentBuiltinTools = options.pluginSubagent?.toolRefs
    ? resolveBuiltinToolRefs(options.pluginSubagent.toolRefs)
    : undefined
  const pluginCustomTools = options.pluginSubagent
    ? wrapSubagentCustomTools(options.pluginSubagent, options.plugins, getOrigin)
    : wrapRegistryTools(options.plugins, getOrigin)

  const tools = wrapSystemAgentTools(
    options.tools ?? (subagentBuiltinTools as AgentSessionTools | undefined),
    options.plugins,
    getOrigin,
  )

  // Hoisted above tool construction so the restart tool can be wired with the
  // session's stable identity (sessionManager.getSessionId()). Subscribers use
  // that ID to distinguish the originating session from siblings on the
  // container-restarting broadcast.
  const sessionManager = options.sessionManager ?? SessionManager.inMemory()

  const customSystemTools =
    options.customTools !== undefined
      ? options.customTools
      : options.pluginSubagent
        ? []
        : [
            websearchTool,
            webfetchTool,
            ...(options.reloadRegistry ? [createReloadTool({ registry: options.reloadRegistry })] : []),
            ...(options.stream ? [createStreamSnapshotTool({ stream: options.stream })] : []),
            ...buildChannelTools(options.channelRouter, options.origin),
            ...(options.containerName
              ? [
                  createRestartTool({
                    containerName: options.containerName,
                    originatingSessionId: sessionManager.getSessionId(),
                    ...(options.stream ? { stream: options.stream } : {}),
                  }),
                ]
              : []),
          ]
  const customTools = [...wrapSystemTools(customSystemTools, options.plugins, getOrigin), ...pluginCustomTools]

  const model = resolveModel(getConfig().model)
  const { session } = await createAgentSession({
    model,
    sessionManager,
    settingsManager: createCompactionSettingsManager(model),
    authStorage,
    modelRegistry,
    resourceLoader,
    ...(tools ? { tools } : {}),
    customTools,
  })

  const unsubRestart = subscribeRestartNotice(options.stream, sessionManager)

  const dispose = async () => {
    unsubRestart?.()
    if (materializedSkills) await materializedSkills.dispose()
  }
  return { session, dispose }
}

// Subscribes the given session to the in-process broadcast that the `restart`
// tool fires on a successful hostd ACK. The subscriber dispatches by identity:
// the session whose tool execution fired the restart (originator) gets a
// `typeclaw.restart-self` notice instructing the model to proactively confirm
// restart completion in its very next reply. All other sessions (siblings) get
// the `typeclaw.restart` notice instructing them not to mention the restart
// unless directly asked. Two distinct customTypes let downstream consumers
// distinguish the cases unambiguously. display:false keeps either entry out of
// any TUI rendering that might inspect the JSONL later. Exported so unit tests
// can verify the wiring without going through createAgentSession (which needs
// auth and model registry); the composition test at the bottom of this
// module's test file covers originator + siblings end to end.
export function subscribeRestartNotice(
  stream: Stream | undefined,
  sessionManager: SessionManager,
): (() => void) | null {
  if (!stream) return null
  const unsub = stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const payload = msg.payload as { kind?: unknown; restartedAt?: unknown; originatingSessionId?: unknown } | null
    if (!payload || payload.kind !== 'container-restarting') return
    if (typeof payload.restartedAt !== 'string') return
    if (typeof payload.originatingSessionId !== 'string') return
    if (payload.originatingSessionId === sessionManager.getSessionId()) {
      sessionManager.appendCustomMessageEntry(
        'typeclaw.restart-self',
        formatRestartNoticeOriginating(payload.restartedAt),
        false,
      )
    } else {
      sessionManager.appendCustomMessageEntry('typeclaw.restart', formatRestartNotice(payload.restartedAt), false)
    }
  })
  return unsub
}

// Convention documented in src/channels/router.ts:996-1013: runtime-injected
// content in the user turn must use the `**[SYSTEM MESSAGE — not from a human]**`
// framing fenced by `---`, plus an explicit "do not acknowledge or reply"
// line. Without it, persona-rich models read the heading as a human-authored
// instruction and reply to it on the next unrelated message.
export function formatRestartNotice(restartedAt: string): string {
  return [
    '---',
    '**[SYSTEM MESSAGE — not from a human]**',
    '',
    `The TypeClaw container was restarted at ${restartedAt}. The previous session`,
    'state was preserved on disk and you have been resumed inside a new container',
    'process. **Do not acknowledge or reply to this notice unless a human directly',
    'asks whether the restart happened.**',
    '',
    'Guidance:',
    '- If a human asks whether you actually restarted, you may confirm: yes, you',
    `  did restart at ${restartedAt}.`,
    '- Otherwise, continue the conversation normally.',
    '',
    '---',
    '',
  ].join('\n')
}

// Variant for the session that called the `restart` tool. The user explicitly
// asked this conversation to restart; staying silent after the reboot is the
// reported bug ("뭐야 너네 재시작 한 것도 모르냐"). This notice instructs the
// model to acknowledge restart completion in its very next reply — once — then
// stop mentioning it. Same SYSTEM MESSAGE framing as the sibling notice so
// persona-rich models don't reply to the framing itself.
export function formatRestartNoticeOriginating(restartedAt: string): string {
  return [
    '---',
    '**[SYSTEM MESSAGE — not from a human]**',
    '',
    `The TypeClaw container was restarted at ${restartedAt} at the user's explicit`,
    'request via the `restart` tool. The restart completed successfully and you',
    'have been resumed inside a new container process with your previous',
    'conversation memory intact.',
    '',
    '**Your very next reply must briefly confirm the restart completed** (e.g.',
    '"restart finished, I\'m back" — or in whatever voice fits your persona),',
    "even if the user's next message is about something unrelated. After that",
    "single confirmation, address whatever the user's next message says, and do",
    'not mention the restart again unless the user explicitly asks about it.',
    '',
    '---',
    '',
  ].join('\n')
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
    tools.push(
      createChannelFetchAttachmentTool({
        router: channelRouter,
        origin: { adapter: origin.adapter },
      }),
    )
  } else {
    tools.push(createChannelSendTool({ router: channelRouter }))
  }
  return tools
}

function wrapRegistryTools(
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
): ToolDefinition[] {
  if (!plugins) return []
  return plugins.registry.tools.map((t: PluginRegisteredTool) =>
    wrapPluginTool(t.tool, {
      pluginName: t.pluginName,
      toolName: t.toolName,
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      logger: t.logger,
      hooks: plugins.hooks,
      getOrigin,
    }),
  )
}

function wrapSystemAgentTools(
  tools: AgentSessionTools | undefined,
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
): AgentSessionTools | undefined {
  if (!tools || !hasToolHooks(plugins)) return tools
  return tools.map((tool) =>
    wrapSystemAgentTool(tool, {
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      hooks: plugins.hooks,
      getOrigin,
    }),
  )
}

function wrapSystemTools(
  tools: ToolDefinition[],
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
): ToolDefinition[] {
  if (!hasToolHooks(plugins)) return tools
  return tools.map((tool) =>
    wrapSystemTool(tool, {
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      hooks: plugins.hooks,
      getOrigin,
    }),
  )
}

function hasToolHooks(plugins: PluginSessionWiring | undefined): plugins is PluginSessionWiring {
  if (!plugins) return false
  return plugins.hooks.count('tool.before') > 0 || plugins.hooks.count('tool.after') > 0
}

function wrapSubagentCustomTools(
  selection: PluginSubagentSelection,
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
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
      getOrigin,
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
  permissions?: PermissionService,
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => withOrigin(systemPrompt, origin, permissions),
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
  permissions?: PermissionService
}

export async function createResourceLoader(options: CreateResourceLoaderOptions = {}): Promise<DefaultResourceLoader> {
  const agentDir = options.agentDir ?? process.cwd()
  const self = await loadSelf(agentDir)
  let systemPrompt = `${DEFAULT_SYSTEM_PROMPT}\n\n${self}`

  if (options.plugins) {
    const event = { prompt: systemPrompt, sessionId: options.plugins.sessionId, agentDir, origin: options.origin }
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
    systemPromptOverride: () => withOrigin(systemPrompt, options.origin, options.permissions),
    appendSystemPromptOverride: () => [],
    additionalSkillPaths,
  })
  await loader.reload()
  return loader
}

function withOrigin(
  systemPrompt: string,
  origin: SessionOrigin | undefined,
  permissions: PermissionService | undefined,
): string {
  if (!origin) return systemPrompt
  const roleContext = resolveRoleContext(origin, permissions)
  return `${systemPrompt}\n\n${renderSessionOrigin(origin, Date.now(), roleContext)}`
}

function resolveRoleContext(
  origin: SessionOrigin,
  permissions: PermissionService | undefined,
): SessionRoleContext | undefined {
  if (permissions === undefined) return undefined
  if (origin.kind === 'tui') return undefined
  return permissions.describe(origin)
}

export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}
