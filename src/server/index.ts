import type { Server as BunServer, ServerWebSocket } from 'bun'

import {
  createSessionWithDispose as defaultCreateSessionWithDispose,
  type AgentSession,
  type CreateSessionOptions,
  type CreateSessionResult,
} from '@/agent'
import type { ChannelRouter } from '@/channels/router'
import type { HookBus } from '@/plugin'
import type { ReloadAllResult, ReloadRegistry } from '@/reload'
import type { PluginRuntime, PluginRuntimeState } from '@/run/plugin-runtime'
import type { SessionFactory } from '@/sessions'
import type { ClientMessage, PromptDelivery, QueueStateItem, ReloadResultPayload, ServerMessage } from '@/shared'
import type { Stream, StreamMessage, StreamMessageId, Unsubscribe } from '@/stream'

export type ReloadAllFn = () => Promise<ReloadAllResult>
export type CreateSessionFn = (options?: CreateSessionOptions) => Promise<AgentSession | CreateSessionResult>

export type ServerOptions = {
  port: number
  reloadAll?: ReloadAllFn
  reloadRegistry?: ReloadRegistry
  createSession?: CreateSessionFn
  sessionFactory?: SessionFactory
  stream?: Stream
  channelRouter?: ChannelRouter
  agentDir?: string
  pluginRuntime?: PluginRuntime
  containerName?: string
}

export type Server = ReturnType<typeof createServer>

type WsData = { sessionId: string }
type Ws = ServerWebSocket<WsData>

type QueuedPrompt = {
  streamMessageId: StreamMessageId
  text: string
  delivery: PromptDelivery
  ts: number
}

type SessionState = {
  session: AgentSession
  sessionFileId: string
  sessionManager: { getSessionFile: () => string | undefined } | undefined
  drainQueue: QueuedPrompt[]
  draining: boolean
  unsubBroadcast: Unsubscribe | null
  unsubPrompts: Unsubscribe | null
  // Captured at session open so close-time hooks fire against the same
  // generation that ran session.start. A plugin reload mid-connection does
  // not re-target this session's lifecycle hooks.
  runtimeSnapshot: PluginRuntimeState | null
  dispose: () => Promise<void>
}

function send(ws: Ws, msg: ServerMessage) {
  ws.send(JSON.stringify(msg))
}

export function createServer({
  port,
  reloadAll,
  reloadRegistry,
  createSession = defaultCreateSessionWithDispose,
  sessionFactory,
  stream,
  channelRouter,
  agentDir,
  pluginRuntime,
  containerName,
}: ServerOptions) {
  const sessionStates = new WeakMap<Ws, SessionState>()

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
          const sessionFileId = sessionManager?.getSessionId() ?? ws.data.sessionId
          // Snapshot the runtime once so the entire session lifecycle for this
          // ws connection sees one consistent generation of registry+hooks. A
          // reload landing mid-connection swaps the live pointer; this session
          // keeps using the snapshot it was created with until close.
          const runtimeSnapshot = pluginRuntime?.get()
          const pluginsWiring =
            runtimeSnapshot !== undefined && agentDir !== undefined
              ? {
                  registry: runtimeSnapshot.registry,
                  hooks: runtimeSnapshot.hooks,
                  sessionId: sessionFileId,
                  agentDir,
                }
              : undefined
          const result = await createSession({
            reloadRegistry,
            sessionManager,
            origin: { kind: 'tui', sessionId: sessionFileId },
            ...(stream ? { stream } : {}),
            ...(channelRouter ? { channelRouter } : {}),
            ...(pluginsWiring ? { plugins: pluginsWiring } : {}),
            ...(containerName !== undefined ? { containerName } : {}),
          })
          const session = 'session' in result ? result.session : result
          const dispose = 'session' in result && result.dispose ? result.dispose : async () => {}

          const state: SessionState = {
            session,
            sessionFileId,
            sessionManager,
            drainQueue: [],
            draining: false,
            unsubBroadcast: null,
            unsubPrompts: null,
            runtimeSnapshot: runtimeSnapshot ?? null,
            dispose,
          }
          sessionStates.set(ws, state)

          if (runtimeSnapshot !== undefined && agentDir !== undefined) {
            await runtimeSnapshot.hooks.runSessionStart({ sessionId: sessionFileId, agentDir })
          }

          forwardSessionEvents(ws, session)

          if (stream) {
            state.unsubPrompts = stream.subscribe({ target: { kind: 'session', sessionId: sessionFileId } }, (msg) =>
              enqueuePrompt(ws, state, msg),
            )

            state.unsubBroadcast = stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
              const payload: ServerMessage = {
                type: 'notification',
                payload: msg.payload,
                ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
                ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
              }
              send(ws, payload)
            })
          }

          send(ws, { type: 'connected', sessionId: sessionFileId })
          console.log(`session ${sessionFileId}: open`)
        },
        async message(ws, raw) {
          const msg = JSON.parse(String(raw)) as ClientMessage
          const state = sessionStates.get(ws)

          if (msg.type === 'reload') {
            await handleReload(ws, reloadAll, reloadRegistry, msg.scope)
            return
          }

          if (msg.type === 'abort') {
            if (!state) return
            await state.session.abort()
            return
          }

          if (msg.type === 'queue_cancel') {
            if (!state) return
            const before = state.drainQueue.length
            state.drainQueue = state.drainQueue.filter((q) => q.streamMessageId !== msg.messageId)
            if (state.drainQueue.length !== before) pushQueueState(ws, state)
            return
          }

          if (msg.type === 'prompt') {
            if (!state) return
            if (stream) {
              stream.publish({
                target: { kind: 'session', sessionId: state.sessionFileId },
                payload: { kind: 'prompt', text: msg.text, delivery: msg.delivery ?? 'queue' },
                meta: { source: 'tui' },
              })
              return
            }
            send(ws, { type: 'prompt_started', messageId: `local-${crypto.randomUUID()}`, text: msg.text })
            try {
              await state.session.prompt(msg.text)
              send(ws, { type: 'done' })
            } catch (err) {
              send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
            }
            const fallbackHooks = state.runtimeSnapshot?.hooks
            if (fallbackHooks !== undefined) {
              await fallbackHooks.runSessionIdle({
                sessionId: state.sessionFileId,
                parentTranscriptPath: state.sessionManager?.getSessionFile(),
                idleMs: 0,
              })
            }
            return
          }
        },
        async close(ws) {
          const state = sessionStates.get(ws)
          state?.unsubBroadcast?.()
          state?.unsubPrompts?.()
          try {
            if (state && state.runtimeSnapshot !== null) {
              await state.runtimeSnapshot.hooks.runSessionEnd({ sessionId: state.sessionFileId })
            }
          } finally {
            if (state) {
              state.session.dispose()
              await state.dispose()
            }
            sessionStates.delete(ws)
            console.log(`session ${state?.sessionFileId ?? ws.data.sessionId}: close`)
          }
        },
      },
    })

    console.log(`typeclaw agent listening on ws://localhost:${bunServer.port}`)
    return bunServer
  }

  return { start }
}

function forwardSessionEvents(ws: Ws, session: AgentSession): void {
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
}

function enqueuePrompt(ws: Ws, state: SessionState, msg: StreamMessage): void {
  const payload = msg.payload as { kind?: string; text?: string; delivery?: PromptDelivery }
  if (payload?.kind !== 'prompt' || typeof payload.text !== 'string') return
  const delivery: PromptDelivery = payload.delivery ?? 'queue'
  if (delivery === 'interrupt') {
    void state.session.abort().catch((err) => {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }
  state.drainQueue.push({
    streamMessageId: msg.id,
    text: payload.text,
    delivery,
    ts: msg.ts,
  })
  pushQueueState(ws, state)
  void drain(ws, state)
}

// `session.idle` semantically means "the agent finished a prompt and is now
// awaiting next input". Plugins (notably the bundled memory plugin) own any
// debouncing on top of this signal. Core fires the hook synchronously after
// every `prompt()` completion (success or error), passing the current
// transcript path so plugins can spawn subagents that read it.
function makeIdleHookCaller(state: SessionState): () => Promise<void> {
  const hooks: HookBus | undefined = state.runtimeSnapshot?.hooks
  if (hooks === undefined) return async () => {}
  return async () => {
    await hooks.runSessionIdle({
      sessionId: state.sessionFileId,
      parentTranscriptPath: state.sessionManager?.getSessionFile(),
      idleMs: 0,
    })
  }
}

async function drain(ws: Ws, state: SessionState): Promise<void> {
  if (state.draining) return
  state.draining = true
  const fireIdle = makeIdleHookCaller(state)
  try {
    while (state.drainQueue.length > 0) {
      const item = state.drainQueue.shift()
      if (!item) break
      pushQueueState(ws, state)
      send(ws, { type: 'prompt_started', messageId: item.streamMessageId, text: item.text })

      try {
        await state.session.prompt(item.text)
        send(ws, { type: 'done' })
      } catch (err) {
        send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      await fireIdle()
    }
  } finally {
    state.draining = false
  }
}

function pushQueueState(ws: Ws, state: SessionState): void {
  const pending: QueueStateItem[] = state.drainQueue.map((q) => ({
    id: q.streamMessageId,
    text: q.text,
    ts: q.ts,
  }))
  send(ws, { type: 'queue_state', pending })
}

async function handleReload(
  ws: Ws,
  reloadAll: ReloadAllFn | undefined,
  reloadRegistry: ReloadRegistry | undefined,
  scope: string | undefined,
): Promise<void> {
  if (scope !== undefined && scope.length > 0) {
    if (!reloadRegistry) {
      send(ws, {
        type: 'reload_result',
        results: [{ scope, ok: false, reason: 'no reload registry configured' }],
      })
      return
    }
    try {
      const result = await reloadRegistry.reloadOne(scope)
      send(ws, { type: 'reload_result', results: [result] })
    } catch (err) {
      send(ws, {
        type: 'reload_result',
        results: [{ scope, ok: false, reason: err instanceof Error ? err.message : String(err) }],
      })
    }
    return
  }

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
