import { createAgentSession, DefaultResourceLoader, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'

import { config, resolveModel } from '@/config'

import { getAuth } from './auth'
import { loadSelf } from './self'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'

export type { AgentSession }

export async function createSession(): Promise<AgentSession> {
  const { authStorage, modelRegistry } = getAuth()
  const resourceLoader = await createResourceLoader()

  const { session } = await createAgentSession({
    model: resolveModel(config.model),
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader,
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
  })
  await loader.reload()
  return loader
}
