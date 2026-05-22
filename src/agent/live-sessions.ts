import type { AgentSession } from './index'

export type LiveAgentSession = {
  sessionId: string
  session: Pick<AgentSession, 'subscribe'>
}

export class LiveSessionRegistry {
  private readonly entries = new Map<string, LiveAgentSession>()

  register(live: LiveAgentSession): void {
    this.entries.set(live.sessionId, live)
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  get(sessionId: string): LiveAgentSession | undefined {
    return this.entries.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
