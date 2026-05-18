import type { Server as BunServer, ServerWebSocket } from 'bun'

import {
  createSessionWithDispose as defaultCreateSessionWithDispose,
  type AgentSession,
  type CreateSessionOptions,
  type CreateSessionResult,
} from '@/agent'
import { runPluginDoctorChecks, runPluginDoctorFix } from '@/agent/doctor'
import { detectProviderError } from '@/agent/provider-error'
import type { SessionOrigin } from '@/agent/session-origin'
import type { ChannelRouter } from '@/channels/router'
import { aggregateCronList, type CronListEntry, loadCron } from '@/cron'
import type { HookBus } from '@/plugin'
import type { BrokerWsData, ContainerBroker } from '@/portbroker'
import type { ReloadAllResult, ReloadRegistry } from '@/reload'
import type { ClaimController, ClaimResultEvent } from '@/role-claim'
import type { PluginRuntime, PluginRuntimeState } from '@/run/plugin-runtime'
import type { SessionFactory } from '@/sessions'
import type {
  ClientMessage,
  CronListEntryPayload,
  CronListSourcePayload,
  PromptDelivery,
  QueueStateItem,
  ReloadResultPayload,
  ServerMessage,
} from '@/shared'
import type { Stream, StreamMessage, StreamMessageId, Unsubscribe } from '@/stream'

export type ReloadAllFn = () => Promise<ReloadAllResult>
export type CreateSessionFn = (options?: CreateSessionOptions) => Promise<AgentSession | CreateSessionResult>

export type ServerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

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
  runtimeVersion?: string
  tuiToken?: string
  // Optional in-process portbroker handler. When provided, requests to the
  // /portbroker WS path are routed to it instead of being treated as TUI
  // sessions. Omit to keep TUI-only behavior (used by tests + non-container
  // dev runs).
  containerBroker?: ContainerBroker
  // Optional logger for server-side events. Defaults to `consoleLogger`
  // which writes to stdout/stderr so `typeclaw logs` surfaces every event.
  // Tests inject a fake logger to assert on captured output.
  logger?: ServerLogger
  // Optional role-claim controller. When set, the server accepts
  // `claim_start` / `claim_cancel` from TUI-class WS clients (the host
  // CLI's `typeclaw role claim` command in particular), and pushes
  // `claim_started` / `claim_completed` / `claim_error` back over the
  // same connection. Omitted in tests that don't exercise the flow.
  claimController?: ClaimController
}

const consoleLogger: ServerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type Server = ReturnType<typeof createServer>

type TuiWsData = { kind: 'tui'; sessionId: string }
type WsData = TuiWsData | BrokerWsData
type Ws = ServerWebSocket<TuiWsData>

type QueuedPrompt = {
  streamMessageId: StreamMessageId
  text: string
  delivery: PromptDelivery
  ts: number
}

type SessionState = {
  session: AgentSession
  sessionFileId: string
  origin: SessionOrigin
  sessionManager: { getSessionFile: () => string | undefined } | undefined
  drainQueue: QueuedPrompt[]
  draining: boolean
  unsubBroadcast: Unsubscribe | null
  unsubPrompts: Unsubscribe | null
  unsubClaim: Unsubscribe | null
  activeClaimCode: string | null
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
  runtimeVersion,
  tuiToken,
  containerBroker,
  logger = consoleLogger,
  claimController,
}: ServerOptions) {
  const sessionStates = new WeakMap<Ws, SessionState>()

  function start(): BunServer<WsData> {
    const bunServer = Bun.serve<WsData>({
      port,
      fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === '/portbroker') {
          if (!containerBroker) return new Response('portbroker disabled', { status: 404 })
          const data: BrokerWsData = { kind: 'portbroker', authed: false }
          if (server.upgrade(req, { data })) return
          return new Response('upgrade failed', { status: 400 })
        }
        if (isWebSocketUpgrade(req) && tuiToken !== undefined && url.searchParams.get('token') !== tuiToken) {
          return new Response('unauthorized', { status: 401 })
        }
        const sessionId = crypto.randomUUID()
        const data: TuiWsData = { kind: 'tui', sessionId }
        if (server.upgrade(req, { data })) return
        return new Response('typeclaw agent', { status: 200 })
      },
      websocket: {
        async open(rawWs) {
          if (rawWs.data.kind === 'portbroker') {
            containerBroker?.open(rawWs as ServerWebSocket<BrokerWsData>)
            return
          }
          const ws = rawWs as Ws
          try {
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
            const origin: SessionOrigin = { kind: 'tui', sessionId: sessionFileId }
            const result = await createSession({
              reloadRegistry,
              sessionManager,
              origin,
              ...(stream ? { stream } : {}),
              ...(channelRouter ? { channelRouter } : {}),
              ...(pluginsWiring ? { plugins: pluginsWiring } : {}),
              ...(containerName !== undefined ? { containerName } : {}),
              ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
            })
            const session = 'session' in result ? result.session : result
            const dispose = 'session' in result && result.dispose ? result.dispose : async () => {}

            const state: SessionState = {
              session,
              sessionFileId,
              origin,
              sessionManager,
              drainQueue: [],
              draining: false,
              unsubBroadcast: null,
              unsubPrompts: null,
              unsubClaim: null,
              activeClaimCode: null,
              runtimeSnapshot: runtimeSnapshot ?? null,
              dispose,
            }
            sessionStates.set(ws, state)

            if (runtimeSnapshot !== undefined && agentDir !== undefined) {
              await runtimeSnapshot.hooks.runSessionStart({ sessionId: sessionFileId, agentDir })
            }

            forwardSessionEvents(ws, session, logger, sessionFileId)

            if (stream) {
              state.unsubPrompts = stream.subscribe({ target: { kind: 'session', sessionId: sessionFileId } }, (msg) =>
                enqueuePrompt(ws, state, msg, agentDir, logger),
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
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`session ${ws.data.sessionId}: open failed: ${message}`)
            send(ws, { type: 'error', message })
            ws.close()
          }
        },
        async message(rawWs, raw) {
          if (rawWs.data.kind === 'portbroker') {
            await containerBroker?.message(rawWs as ServerWebSocket<BrokerWsData>, raw as string | Buffer)
            return
          }
          const ws = rawWs as Ws
          const msg = JSON.parse(String(raw)) as ClientMessage
          const state = sessionStates.get(ws)

          if (msg.type === 'claim_start') {
            if (!state) return
            if (!claimController) {
              send(ws, {
                type: 'claim_error',
                payload: { code: msg.code, reason: 'role-claim is not enabled on this agent' },
              })
              return
            }
            if (state.unsubClaim) {
              state.unsubClaim()
              state.unsubClaim = null
            }
            const result = claimController.startClaim({
              code: msg.code,
              role: msg.role,
              ttlMs: msg.ttlMs,
              ...(msg.channel !== undefined ? { channel: msg.channel } : {}),
            })
            if (!result.ok) {
              send(ws, { type: 'claim_error', payload: { code: msg.code, reason: result.reason } })
              return
            }
            state.activeClaimCode = msg.code
            state.unsubClaim = claimController.onResult((event: ClaimResultEvent) => {
              if (event.kind === 'completed' && event.code === msg.code) {
                send(ws, {
                  type: 'claim_completed',
                  payload: {
                    code: event.code,
                    role: event.role,
                    matchRule: event.matchRule,
                    adapter: event.adapter,
                    authorId: event.authorId,
                  },
                })
              } else if (event.kind === 'error' && event.code === msg.code) {
                send(ws, { type: 'claim_error', payload: { code: event.code, reason: event.reason } })
              } else if (event.kind === 'cancelled' && event.code === msg.code) {
                send(ws, { type: 'claim_error', payload: { code: event.code, reason: 'cancelled' } })
              }
            })
            send(ws, {
              type: 'claim_started',
              payload: {
                code: msg.code,
                role: msg.role,
                ...(msg.channel !== undefined ? { channel: msg.channel } : {}),
                expiresAt: result.expiresAt,
              },
            })
            return
          }

          if (msg.type === 'claim_cancel') {
            if (!state || !claimController) return
            if (state.activeClaimCode !== null) {
              claimController.cancelClaim(state.activeClaimCode)
              state.activeClaimCode = null
            }
            if (state.unsubClaim) {
              state.unsubClaim()
              state.unsubClaim = null
            }
            return
          }

          if (msg.type === 'reload') {
            await handleReload(ws, reloadAll, reloadRegistry, msg.scope)
            return
          }

          if (msg.type === 'doctor') {
            await handleDoctor(ws, msg.requestId, pluginRuntime, agentDir)
            return
          }

          if (msg.type === 'doctor_fix') {
            await handleDoctorFix(ws, msg.requestId, msg.checkId, pluginRuntime, agentDir)
            return
          }

          if (msg.type === 'cron_list') {
            await handleCronList(ws, msg.requestId, pluginRuntime, agentDir)
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
            const fallbackHooks = state.runtimeSnapshot?.hooks
            if (fallbackHooks !== undefined && agentDir !== undefined) {
              await fallbackHooks.runSessionTurnStart({
                sessionId: state.sessionFileId,
                agentDir,
                origin: state.origin,
              })
            }
            try {
              await state.session.prompt(msg.text)
              send(ws, { type: 'done' })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              logger.error(`[server] ${state.sessionFileId}: prompt failed: ${message}`)
              send(ws, { type: 'error', message })
            }
            if (fallbackHooks !== undefined && agentDir !== undefined) {
              await fallbackHooks.runSessionTurnEnd({
                sessionId: state.sessionFileId,
                agentDir,
                origin: state.origin,
              })
            }
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
        async close(rawWs) {
          if (rawWs.data.kind === 'portbroker') {
            containerBroker?.close(rawWs as ServerWebSocket<BrokerWsData>)
            return
          }
          const ws = rawWs as Ws
          const state = sessionStates.get(ws)
          state?.unsubBroadcast?.()
          state?.unsubPrompts?.()
          state?.unsubClaim?.()
          if (state?.activeClaimCode !== null && state?.activeClaimCode !== undefined && claimController) {
            claimController.cancelClaim(state.activeClaimCode)
          }
          try {
            if (state && state.runtimeSnapshot !== null) {
              await state.runtimeSnapshot.hooks.runSessionEnd({ sessionId: state.sessionFileId, origin: state.origin })
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

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

function forwardSessionEvents(ws: Ws, session: AgentSession, logger: ServerLogger, sessionFileId: string): void {
  const toolStartedAt = new Map<string, number>()

  session.subscribe((event) => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          send(ws, { type: 'text_delta', delta: event.assistantMessageEvent.delta })
        }
        break
      case 'message_end':
        // pi-coding-agent encodes upstream LLM failures (billing, rate limit,
        // network, malformed response, etc.) in the assistant message itself
        // rather than throwing — `stopReason: 'error'` with a populated
        // `errorMessage`. Without this branch the user sees an empty turn
        // because no text deltas were ever emitted, which looks like a freeze.
        // The server's existing try/catch around `session.prompt()` only
        // catches throws, so it never sees these.
        forwardAssistantError(ws, event.message, logger, sessionFileId)
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

function forwardAssistantError(ws: Ws, message: unknown, logger: ServerLogger, sessionFileId: string): void {
  const detected = detectProviderError(message)
  if (detected === null) return
  logger.error(`[server] ${sessionFileId}: LLM call failed: ${detected.message}`)
  send(ws, { type: 'error', message: detected.message })
}

function enqueuePrompt(
  ws: Ws,
  state: SessionState,
  msg: StreamMessage,
  agentDir: string | undefined,
  logger: ServerLogger,
): void {
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
  void drain(ws, state, agentDir, logger)
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
      origin: state.origin,
    })
  }
}

function makeTurnHookCallers(
  state: SessionState,
  agentDir: string | undefined,
): { fireTurnStart: () => Promise<void>; fireTurnEnd: () => Promise<void> } {
  const hooks: HookBus | undefined = state.runtimeSnapshot?.hooks
  if (hooks === undefined || agentDir === undefined) {
    return { fireTurnStart: async () => {}, fireTurnEnd: async () => {} }
  }
  const event = { sessionId: state.sessionFileId, agentDir, origin: state.origin }
  return {
    fireTurnStart: () => hooks.runSessionTurnStart(event),
    fireTurnEnd: () => hooks.runSessionTurnEnd(event),
  }
}

async function drain(ws: Ws, state: SessionState, agentDir: string | undefined, logger: ServerLogger): Promise<void> {
  if (state.draining) return
  state.draining = true
  const fireIdle = makeIdleHookCaller(state)
  const { fireTurnStart, fireTurnEnd } = makeTurnHookCallers(state, agentDir)
  try {
    while (state.drainQueue.length > 0) {
      const item = state.drainQueue.shift()
      if (!item) break
      pushQueueState(ws, state)
      send(ws, { type: 'prompt_started', messageId: item.streamMessageId, text: item.text })

      await fireTurnStart()
      try {
        await state.session.prompt(item.text)
        send(ws, { type: 'done' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`[server] ${state.sessionFileId}: prompt failed: ${message}`)
        send(ws, { type: 'error', message })
      }
      await fireTurnEnd()
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

async function handleDoctor(
  ws: Ws,
  requestId: string,
  pluginRuntime: PluginRuntime | undefined,
  agentDir: string | undefined,
): Promise<void> {
  if (pluginRuntime === undefined || agentDir === undefined) {
    send(ws, { type: 'doctor_result', requestId, checks: [] })
    return
  }
  const snapshot = pluginRuntime.get()
  if (snapshot === undefined) {
    send(ws, { type: 'doctor_result', requestId, checks: [] })
    return
  }
  try {
    const checks = await runPluginDoctorChecks({ registry: snapshot.registry, agentDir })
    send(ws, { type: 'doctor_result', requestId, checks })
  } catch (err) {
    send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

async function handleDoctorFix(
  ws: Ws,
  requestId: string,
  checkId: string,
  pluginRuntime: PluginRuntime | undefined,
  agentDir: string | undefined,
): Promise<void> {
  if (pluginRuntime === undefined || agentDir === undefined) {
    send(ws, {
      type: 'doctor_fix_result',
      requestId,
      result: { ok: false, checkId, error: 'plugin runtime not configured' },
    })
    return
  }
  const snapshot = pluginRuntime.get()
  if (snapshot === undefined) {
    send(ws, {
      type: 'doctor_fix_result',
      requestId,
      result: { ok: false, checkId, error: 'plugin runtime not configured' },
    })
    return
  }
  const outcome = await runPluginDoctorFix({ registry: snapshot.registry, agentDir, checkId })
  const result =
    outcome.ok === true
      ? { ok: true as const, checkId, summary: outcome.summary, changedPaths: outcome.changedPaths }
      : { ok: false as const, checkId, error: outcome.error }
  send(ws, { type: 'doctor_fix_result', requestId, result })
}

async function handleCronList(
  ws: Ws,
  requestId: string,
  pluginRuntime: PluginRuntime | undefined,
  agentDir: string | undefined,
): Promise<void> {
  if (agentDir === undefined) {
    send(ws, { type: 'cron_list_result', requestId, result: { ok: false, reason: 'agentDir not configured' } })
    return
  }
  try {
    // Snapshot the runtime once so subagent validation and the plugin
    // cron-job list see the same generation, the way TUI sessions do.
    // Without one snapshot, a reload landing mid-request can show user
    // jobs validated against an old subagent registry alongside plugin
    // jobs from a newer registry.
    const snapshot = pluginRuntime?.get()
    const loadResult = await loadCron(agentDir, {
      // Read-only path: do not rewrite cron.json or commit the
      // migration just because the user (or the agent) asked to see
      // the schedule. Boot/reload still own the persistent migration.
      persistMigrations: false,
      ...(snapshot !== undefined ? { subagents: snapshot.subagents } : {}),
    })
    if (!loadResult.ok) {
      send(ws, { type: 'cron_list_result', requestId, result: { ok: false, reason: loadResult.reason } })
      return
    }
    const userJobs = loadResult.file?.jobs ?? []
    const pluginJobs = snapshot?.registry.cronJobs ?? []
    const nowMs = Date.now()
    const entries = aggregateCronList({ userJobs, pluginJobs, now: nowMs })
    send(ws, {
      type: 'cron_list_result',
      requestId,
      result: { ok: true, jobs: entries.map(toPayload), nowMs },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    send(ws, { type: 'cron_list_result', requestId, result: { ok: false, reason } })
  }
}

function toPayload(entry: CronListEntry): CronListEntryPayload {
  const source: CronListSourcePayload =
    entry.source.kind === 'plugin'
      ? { kind: 'plugin', pluginName: entry.source.pluginName, localId: entry.source.localId }
      : { kind: 'user' }
  return {
    id: entry.id,
    source,
    kind: entry.kind,
    schedule: entry.schedule,
    enabled: entry.enabled,
    nextFireMs: entry.nextFireMs,
    ...(entry.timezone !== undefined ? { timezone: entry.timezone } : {}),
    ...(entry.scheduledByRole !== undefined ? { scheduledByRole: entry.scheduledByRole } : {}),
    ...(entry.scheduleError !== undefined ? { scheduleError: entry.scheduleError } : {}),
    ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
    ...(entry.subagent !== undefined ? { subagent: entry.subagent } : {}),
    ...(entry.command !== undefined ? { command: entry.command } : {}),
  }
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
