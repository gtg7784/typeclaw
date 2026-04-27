import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool = AgentTool<any>

import { config, resolveModel } from '@/config'
import type { ReloadRegistry } from '@/reload'
import type { Stream } from '@/stream'

import { getAuth } from './auth'
import { createReloadTool } from './reload-tool'
import { loadSelf } from './self'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'
import { createStreamSnapshotTool } from './tools/stream-snapshot'
import { webfetchTool } from './tools/webfetch'
import { websearchTool } from './tools/websearch'

export type { AgentSession }

export type CreateSessionOptions = {
  reloadRegistry?: ReloadRegistry
  sessionManager?: SessionManager
  stream?: Stream
}

export async function createSession(options: CreateSessionOptions = {}): Promise<AgentSession> {
  const { authStorage, modelRegistry } = getAuth()
  const resourceLoader = await createResourceLoader()
  const customTools = [
    websearchTool,
    webfetchTool,
    ...(options.reloadRegistry ? [createReloadTool({ registry: options.reloadRegistry })] : []),
    ...(options.stream ? [createStreamSnapshotTool({ stream: options.stream })] : []),
  ]

  const { session } = await createAgentSession({
    model: resolveModel(config.model),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader,
    customTools,
  })
  return session
}

export type CreateSubagentSessionOptions = {
  tools: Tool[]
  systemPrompt: string
  sessionManager: SessionManager
}

export async function createSubagentSession({
  tools,
  systemPrompt,
  sessionManager,
}: CreateSubagentSessionOptions): Promise<AgentSession> {
  const { authStorage, modelRegistry } = getAuth()
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  const { session } = await createAgentSession({
    model: resolveModel(config.model),
    sessionManager,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    tools,
  })
  return session
}

export async function createResourceLoader(options: { agentDir?: string } = {}): Promise<DefaultResourceLoader> {
  const agentDir = options.agentDir ?? process.cwd()
  const self = await loadSelf(agentDir)
  const systemPrompt = `${DEFAULT_SYSTEM_PROMPT}\n\n${self}`

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalSkillPaths: [getBundledSkillsDir()],
  })
  await loader.reload()
  return loader
}

export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}
