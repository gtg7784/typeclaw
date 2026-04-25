import type { Server as BunServer, ServerWebSocket } from 'bun'

import { createSession as defaultCreateSession, type AgentSession, type CreateSessionOptions } from '@/agent'
import type { ReloadAllResult, ReloadRegistry } from '@/reload'
import type { SessionFactory } from '@/sessions'
import type { ClientMessage, ReloadResultPayload, ServerMessage } from '@/shared'

export type ReloadAllFn = () => Promise<ReloadAllResult>
export type CreateSessionFn = (options?: CreateSessionOptions) => Promise<AgentSession>

export type ServerOptions = {
  port: number
  reloadAll?: ReloadAllFn
  reloadRegistry?: ReloadRegistry
  createSession?: CreateSessionFn
  sessionFactory?: SessionFactory
}

export type Server = ReturnType<typeof createServer>

type WsData = { sessionId: string }
type Ws = ServerWebSocket<WsData>

function send(ws: Ws, msg: ServerMessage) {
  ws.send(JSON.stringify(msg))
}

export function createServer({
  port,
  reloadAll,
  reloadRegistry,
  createSession = defaultCreateSession,
  sessionFactory,
}: ServerOptions) {
  const sessions = new WeakMap<Ws, AgentSession>()

  function start(): BunServer<WsData> {
    const bunServer = Bun.serve<WsData>({
      port,
      fetch(req, server) {
        const sessionId = crypto.randomUUID()
        if (server.upgrade(req, { data: { sessionId } })) return
        return new Response('typeclaw agent', { status: 200 })
      },
      websocket: {
        async open(ws) {
          const sessionManager = sessionFactory?.createPersisted()
          const session = await createSession({ reloadRegistry, sessionManager })
          sessions.set(ws, session)

          // Upstream tool events have no duration; we derive it by correlating start/end via toolCallId.
          const toolStartedAt = new Map<string, number>()

          session.subscribe((event) => {
            switch (event.type) {
              case 'message_update':
                if (event.assistantMessageEvent.type === 'text_delta') {
                  send(ws, { type: 'text_delta', delta: event.assistantMessageEvent.delta })
                }
                break
              case 'tool_execution_start':
                toolStartedAt.set(event.toolCallId, Date.now())
                send(ws, {
                  type: 'tool_start',
                  toolCallId: event.toolCallId,
                  name: event.toolName,
                  args: event.args,
                })
                break
              case 'tool_execution_end': {
                const startedAt = toolStartedAt.get(event.toolCallId)
                toolStartedAt.delete(event.toolCallId)
                const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt
                send(ws, {
                  type: 'tool_end',
                  toolCallId: event.toolCallId,
                  name: event.toolName,
                  error: event.isError,
                  result: event.result,
                  durationMs,
                })
                break
              }
            }
          })

          send(ws, { type: 'connected', sessionId: ws.data.sessionId })
          console.log(`session ${ws.data.sessionId}: open`)
        },
        async message(ws, raw) {
          const msg = JSON.parse(String(raw)) as ClientMessage

          if (msg.type === 'reload') {
            await handleReload(ws, reloadAll)
            return
          }

          if (msg.type === 'abort') {
            const session = sessions.get(ws)
            if (!session) return
            await session.abort()
            return
          }

          if (msg.type === 'prompt') {
            const session = sessions.get(ws)
            if (!session) return
            try {
              await session.prompt(msg.text)
              send(ws, { type: 'done' })
            } catch (err) {
              send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
            }
            return
          }
        },
        close(ws) {
          sessions.delete(ws)
          console.log(`session ${ws.data.sessionId}: close`)
        },
      },
    })

    console.log(`typeclaw agent listening on ws://localhost:${bunServer.port}`)
    return bunServer
  }

  return { start }
}

async function handleReload(ws: Ws, reloadAll: ReloadAllFn | undefined): Promise<void> {
  if (!reloadAll) {
    const empty: ReloadResultPayload[] = []
    send(ws, { type: 'reload_result', results: empty })
    return
  }
  try {
    const { results } = await reloadAll()
    send(ws, { type: 'reload_result', results })
  } catch (err) {
    send(ws, {
      type: 'reload_result',
      results: [{ scope: 'reload', ok: false, reason: err instanceof Error ? err.message : String(err) }],
    })
  }
}
