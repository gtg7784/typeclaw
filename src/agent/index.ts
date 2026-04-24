import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentSession, DefaultResourceLoader, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'

import { config, resolveModel } from '@/config'
import type { ReloadRegistry } from '@/reload'

import { getAuth } from './auth'
import { createReloadTool } from './reload-tool'
import { loadSelf } from './self'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'

export type { AgentSession }

export type CreateSessionOptions = {
  reloadRegistry?: ReloadRegistry
}

export async function createSession(options: CreateSessionOptions = {}): Promise<AgentSession> {
  const { authStorage, modelRegistry } = getAuth()
  const resourceLoader = await createResourceLoader()
  const customTools = options.reloadRegistry ? [createReloadTool({ registry: options.reloadRegistry })] : []

  const { session } = await createAgentSession({
    model: resolveModel(config.model),
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader,
    customTools,
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
