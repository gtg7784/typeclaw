import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession as defaultCreateSession } from '@/agent'
import type { CreateSessionForChannel, ChannelRouter } from '@/channels'
import type { ReloadRegistry } from '@/reload'
import type { SessionFactory } from '@/sessions'
import type { Stream } from '@/stream'

import type { PluginRuntime } from './plugin-runtime'

export type BuildChannelSessionFactoryDeps = {
  cwd: string
  sessionFactory: SessionFactory
  stream: Stream
  reloadRegistry: ReloadRegistry
  pluginRuntime: PluginRuntime
  // Late-bound: the router is constructed by the channel manager which itself
  // takes this factory. Reading the router lazily breaks the construction
  // cycle while still ensuring the factory's sessions get the same router
  // their inbound messages came from.
  getChannelRouter: () => ChannelRouter
  containerName?: string
  // Test seam: lets a fake stand in for the agent session creator so tests
  // can assert exactly which CreateSessionOptions the factory builds without
  // needing a live LLM, plugin runtime, or session manager on disk.
  createSession?: typeof defaultCreateSession
}

// The production wiring for channel-routed sessions. Channel inbounds arrive
// at the router, the router calls this factory to get an AgentSession, and
// the agent uses `channel_send` to reply. If `channelRouter` is missing here
// the agent has no `channel_send` tool and cannot reply — silently. That was
// the bug this factory exists to prevent. The shape of these options must
// stay aligned with createSessionForCron in src/run/index.ts; both are
// "channel-aware" sessions that need the same full plumbing.
export function buildChannelSessionFactory(deps: BuildChannelSessionFactoryDeps): CreateSessionForChannel {
  const createSession = deps.createSession ?? defaultCreateSession
  return async ({ existingSessionId, existingSessionFile, origin, originRef }) => {
    const sessionDir = deps.sessionFactory.sessionDir()
    const sessionManager =
      existingSessionId !== undefined
        ? tryReopenOrCreate(deps.cwd, sessionDir, existingSessionId, existingSessionFile)
        : SessionManager.create(deps.cwd, sessionDir)

    const snap = deps.pluginRuntime.get()
    const session = await createSession({
      reloadRegistry: deps.reloadRegistry,
      sessionManager,
      stream: deps.stream,
      channelRouter: deps.getChannelRouter(),
      origin,
      originRef,
      ...(snap.hasAnyPluginContent
        ? {
            plugins: {
              registry: snap.registry,
              hooks: snap.hooks,
              sessionId: sessionManager.getSessionId(),
              agentDir: deps.cwd,
            },
          }
        : {}),
      ...(deps.containerName !== undefined ? { containerName: deps.containerName } : {}),
    })

    return {
      session,
      sessionId: sessionManager.getSessionId(),
      dispose: async () => {
        session.dispose()
      },
      ...(snap.hasAnyPluginContent ? { hooks: snap.hooks } : {}),
      getTranscriptPath: () => sessionManager.getSessionFile(),
    }
  }
}

// Reopen the persisted session manager when possible so the agent picks up
// where it left off. We use the persisted basename (sessionFile) directly
// because pi-coding-agent prefixes filenames with an ISO timestamp at write
// time that is not derivable from sessionId alone. Failure to reopen
// (corruption, missing file, schema drift, or v2 mapping with no sessionFile)
// falls back to a fresh session — matching the router's existing best-effort
// durability for channel sessions.
function tryReopenOrCreate(
  cwd: string,
  sessionDir: string,
  existingSessionId: string,
  existingSessionFile: string | undefined,
): SessionManager {
  if (existingSessionFile === undefined) {
    console.warn(
      `[channels] session ${existingSessionId} has no sessionFile (v2 mapping not yet migrated); creating new`,
    )
    return SessionManager.create(cwd, sessionDir)
  }
  try {
    return SessionManager.open(`${sessionDir}/${existingSessionFile}`)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(
      `[channels] could not rehydrate session ${existingSessionId} from ${existingSessionFile}: ${reason}; creating new`,
    )
    return SessionManager.create(cwd, sessionDir)
  }
}
