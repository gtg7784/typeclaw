import { createAgentSession, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'

import { config } from '@/config'

import { getAuth } from './auth'

export type { AgentSession }

export async function createSession(): Promise<AgentSession> {
  const { authStorage, modelRegistry } = getAuth()
  const { session } = await createAgentSession({
    model: config.model,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
  })
  return session
}
