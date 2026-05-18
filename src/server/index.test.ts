import { afterEach, describe, expect, test } from 'bun:test'

import { SessionManager } from '@mariozechner/pi-coding-agent'

import type { AgentSession, CreateSessionOptions } from '@/agent'
import type { HookBus, PluginRegistry } from '@/plugin'
import { createPluginRuntime, type PluginRuntime } from '@/run/plugin-runtime'
import type { SessionFactory } from '@/sessions'
import type { ServerMessage } from '@/shared'
import { createStream } from '@/stream'

import type { CommandOutbound, CommandRunner } from './command-runner'
import { createServer, safeWsSend, type ServerLogger } from './index'

function makeRuntime(opts: { registry: PluginRegistry; hooks: HookBus }): PluginRuntime {
  return createPluginRuntime({
    registry: opts.registry,
    hooks: opts.hooks,
    subagents: {},
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: false,
    loadedPlugins: [],
    materializedSkills: null,
  })
}

type SessionEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }

let server: ReturnType<ReturnType<typeof createServer>['start']> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

function createFakeSession(): AgentSession & {
  emit: (event: SessionEvent) => void
  abortCalls: number
  promptCalls: string[]
  disposeCalls: number
  resolvePrompt: () => void
  rejectPrompt: (err: Error) => void
} {
  const subscribers = new Set<(event: SessionEvent) => void>()
  let pendingPromptResolve: (() => void) | null = null
  let pendingPromptReject: ((err: Error) => void) | null = null
  const fake = {
    subscribe: (fn: (event: SessionEvent) => void) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    prompt: async (text: string) => {
      fake.promptCalls.push(text)
      await new Promise<void>((resolve, reject) => {
        pendingPromptResolve = resolve
        pendingPromptReject = reject
      })
    },
    abort: async () => {
      fake.abortCalls++
      pendingPromptResolve?.()
      pendingPromptResolve = null
      pendingPromptReject = null
    },
    dispose: () => {
      fake.disposeCalls++
    },
    emit: (event: SessionEvent) => {
      for (const fn of subscribers) fn(event)
    },
    resolvePrompt: () => {
      pendingPromptResolve?.()
      pendingPromptResolve = null
      pendingPromptReject = null
    },
    rejectPrompt: (err: Error) => {
      pendingPromptReject?.(err)
      pendingPromptResolve = null
      pendingPromptReject = null
    },
    abortCalls: 0,
    disposeCalls: 0,
    promptCalls: [] as string[],
  }
  return fake as unknown as ReturnType<typeof createFakeSession>
}

async function startWithSession(
  session: AgentSession,
  extra: {
    stream?: ReturnType<typeof createStream>
    sessionFactory?: SessionFactory
    agentDir?: string
    pluginRegistry?: PluginRegistry
    pluginHooks?: HookBus
    logger?: ServerLogger
    commandRunnerFactory?: (outbound: CommandOutbound) => CommandRunner
  } = {},
): Promise<{ url: string }> {
  const pluginRuntime =
    extra.pluginRegistry !== undefined && extra.pluginHooks !== undefined
      ? makeRuntime({ registry: extra.pluginRegistry, hooks: extra.pluginHooks })
      : undefined
  const built = createServer({
    port: 0,
    createSession: async () => session,
    ...(extra.stream ? { stream: extra.stream } : {}),
    ...(extra.sessionFactory ? { sessionFactory: extra.sessionFactory } : {}),
    ...(extra.agentDir !== undefined ? { agentDir: extra.agentDir } : {}),
    ...(pluginRuntime ? { pluginRuntime } : {}),
    ...(extra.logger ? { logger: extra.logger } : {}),
    ...(extra.commandRunnerFactory ? { commandRunnerFactory: extra.commandRunnerFactory } : {}),
  }).start()
  server = built
  return { url: `ws://localhost:${built.port}` }
}

async function connect(url: string): Promise<{
  ws: WebSocket
  received: ServerMessage[]
  waitFor: (predicate: (msg: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>
}> {
  const ws = new WebSocket(url)
  const received: ServerMessage[] = []
  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)) as ServerMessage)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (err) => reject(err), { once: true })
  })
  const waitFor = async (predicate: (msg: ServerMessage) => boolean, timeoutMs = 1000): Promise<ServerMessage> => {
    const existing = received.find(predicate)
    if (existing) return existing
    return await new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs)
      const onMessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage
        if (predicate(msg)) {
          clearTimeout(timer)
          ws.removeEventListener('message', onMessage)
          resolve(msg)
        }
      }
      ws.addEventListener('message', onMessage)
    })
  }
  return { ws, received, waitFor }
}

describe('createServer tool event forwarding', () => {
  test('rejects TUI websocket upgrades without the expected token', async () => {
    const built = createServer({ port: 0, createSession: async () => createFakeSession(), tuiToken: 'secret' }).start()
    server = built

    const ws = new WebSocket(`ws://localhost:${built.port}`)

    await new Promise<void>((resolve) => ws.addEventListener('close', () => resolve(), { once: true }))
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  test('accepts TUI websocket upgrades with the expected token', async () => {
    const built = createServer({ port: 0, createSession: async () => createFakeSession(), tuiToken: 'secret' }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}?token=secret`)

    await expect(waitFor((m) => m.type === 'connected')).resolves.toMatchObject({ type: 'connected' })
    ws.close()
  })

  test('sends an error frame when session creation fails during websocket open', async () => {
    const built = createServer({
      port: 0,
      createSession: async () => {
        throw new Error('auth missing')
      },
    }).start()
    server = built

    const { waitFor } = await connect(`ws://localhost:${built.port}`)

    await expect(waitFor((m) => m.type === 'error')).resolves.toEqual({ type: 'error', message: 'auth missing' })
  })

  test('forwards toolCallId, name, and args from tool_execution_start', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'Read', args: { path: '/x' } })

    const msg = await waitFor((m) => m.type === 'tool_start')
    expect(msg).toEqual({ type: 'tool_start', toolCallId: 'tc-1', name: 'Read', args: { path: '/x' } })
    ws.close()
  })

  test('forwards toolCallId, name, error, result, and a non-negative durationMs from tool_execution_end', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-2', toolName: 'Bash', args: 'ls' })
    await waitFor((m) => m.type === 'tool_start')
    session.emit({ type: 'tool_execution_end', toolCallId: 'tc-2', toolName: 'Bash', result: 'a\nb', isError: false })

    const msg = await waitFor((m) => m.type === 'tool_end')
    expect(msg.type).toBe('tool_end')
    if (msg.type !== 'tool_end') throw new Error('unreachable')
    expect(msg.toolCallId).toBe('tc-2')
    expect(msg.name).toBe('Bash')
    expect(msg.error).toBe(false)
    expect(msg.result).toBe('a\nb')
    expect(msg.durationMs).toBeGreaterThanOrEqual(0)
    ws.close()
  })

  test('uses durationMs=0 when tool_execution_end arrives without a matching start', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_end', toolCallId: 'orphan', toolName: 'X', result: null, isError: true })

    const msg = await waitFor((m) => m.type === 'tool_end')
    if (msg.type !== 'tool_end') throw new Error('unreachable')
    expect(msg.durationMs).toBe(0)
    expect(msg.error).toBe(true)
    ws.close()
  })

  test('forwards assistant message_end with stopReason=error as a TUI error event (LLM-side failures like billing/rate-limit do not throw)', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-5.4-nano',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        errorMessage: 'Your account is not active, please check your billing details on our website.',
        timestamp: Date.now(),
      },
    } as unknown as SessionEvent)

    const msg = await waitFor((m) => m.type === 'error')
    if (msg.type !== 'error') throw new Error('unreachable')
    expect(msg.message).toBe('Your account is not active, please check your billing details on our website.')
    ws.close()
  })

  test('falls back to a generic message when stopReason=error has no errorMessage', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: undefined,
      },
    } as unknown as SessionEvent)

    const msg = await waitFor((m) => m.type === 'error')
    if (msg.type !== 'error') throw new Error('unreachable')
    expect(msg.message).toBe('LLM call failed')
    ws.close()
  })

  test('does not surface an error event for non-assistant message_end (user/toolResult)', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    let errorSeen = false
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage
      if (m.type === 'error') errorSeen = true
    })

    session.emit({
      type: 'message_end',
      message: { role: 'user', content: 'hello', timestamp: Date.now() },
    } as unknown as SessionEvent)

    // Sentinel: emit a tool_start so we have something to await on; if an
    // error were fired for the user message it would arrive before this.
    session.emit({ type: 'tool_execution_start', toolCallId: 'sentinel', toolName: 'Read', args: {} })
    await waitFor((m) => m.type === 'tool_start')

    expect(errorSeen).toBe(false)
    ws.close()
  })

  test('does not surface an error event for stopReason=aborted (TUI shows abort feedback elsewhere)', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    let errorSeen = false
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage
      if (m.type === 'error') errorSeen = true
    })

    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
      },
    } as unknown as SessionEvent)

    session.emit({ type: 'tool_execution_start', toolCallId: 'sentinel-2', toolName: 'Read', args: {} })
    await waitFor((m) => m.type === 'tool_start')

    expect(errorSeen).toBe(false)
    ws.close()
  })
})

describe('createServer abort handling (no stream — fallback path)', () => {
  test('client { type: "abort" } invokes session.abort()', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'prompt', text: 'do thing' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(session.promptCalls).toEqual(['do thing'])
    expect(session.abortCalls).toBe(0)

    ws.send(JSON.stringify({ type: 'abort' }))
    await waitFor((m) => m.type === 'done')
    expect(session.abortCalls).toBe(1)
    ws.close()
  })

  test('abort with no in-flight prompt is still a safe no-op', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'abort' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(session.abortCalls).toBe(1)
    ws.close()
  })
})

describe('createServer session persistence wiring', () => {
  function makeStubFactory() {
    const created: SessionManager[] = []
    const factory: SessionFactory = {
      createPersisted: () => {
        const mgr = SessionManager.inMemory()
        created.push(mgr)
        return mgr
      },
      sessionDir: () => '/stub/sessions',
    }
    return { factory, created }
  }

  test('invokes sessionFactory.createPersisted() once per ws open and forwards the manager into createSession', async () => {
    // given
    const session = createFakeSession()
    const { factory, created } = makeStubFactory()
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      sessionFactory: factory,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // then
    expect(created).toHaveLength(1)
    expect(observed).toHaveLength(1)
    expect(observed[0]?.sessionManager).toBe(created[0])

    ws.close()
  })

  test('produces a fresh sessionManager for each ws connection', async () => {
    // given
    const session = createFakeSession()
    const { factory, created } = makeStubFactory()
    const built = createServer({
      port: 0,
      sessionFactory: factory,
      createSession: async () => session,
    }).start()
    server = built
    const url = `ws://localhost:${built.port}`

    // when
    const a = await connect(url)
    await a.waitFor((m) => m.type === 'connected')
    const b = await connect(url)
    await b.waitFor((m) => m.type === 'connected')

    // then
    expect(created).toHaveLength(2)
    expect(created[0]).not.toBe(created[1])

    a.ws.close()
    b.ws.close()
  })

  test('omits sessionManager from createSession options when no factory is configured (preserves in-memory default)', async () => {
    // given
    const session = createFakeSession()
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // then
    expect(observed).toHaveLength(1)
    expect(observed[0]?.sessionManager).toBeUndefined()

    ws.close()
  })

  test('connected message carries the persisted session file id when a factory is configured', async () => {
    // given
    const session = createFakeSession()
    const { factory } = makeStubFactory()
    const { url } = await startWithSession(session, { sessionFactory: factory })

    // when
    const { ws, waitFor } = await connect(url)
    const connected = await waitFor((m) => m.type === 'connected')

    // then
    if (connected.type !== 'connected') throw new Error('unreachable')
    expect(connected.sessionId).toBeDefined()
    expect(connected.sessionId.length).toBeGreaterThan(0)

    ws.close()
  })
})

describe('createServer with stream — input queueing bugfix', () => {
  test('a single prompt is published to the stream, drained, and yields a done message', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'prompt', text: 'hello' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(session.promptCalls).toEqual(['hello'])

    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    // then
    expect(session.promptCalls).toEqual(['hello'])

    ws.close()
  })

  test('emits prompt_started before invoking session.prompt() so the TUI can render execution-order history', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))
    const started = await waitFor((m) => m.type === 'prompt_started')

    // then: prompt_started arrived; session.prompt was called with the same text
    if (started.type !== 'prompt_started') throw new Error('unreachable')
    expect(started.text).toBe('hi')
    expect(started.messageId).toBeDefined()
    expect(session.promptCalls).toEqual(['hi'])

    session.resolvePrompt()
    ws.close()
  })

  test('two concurrent prompts are serialized via the drain loop (no concurrent session.prompt calls)', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: fire two prompts back-to-back while the first is still in flight
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await new Promise((r) => setTimeout(r, 30))

    // then: only the first reached session.prompt — the second is queued
    expect(session.promptCalls).toEqual(['first'])

    // when: first completes
    session.resolvePrompt()
    await new Promise((r) => setTimeout(r, 30))

    // then: second now reaches session.prompt
    expect(session.promptCalls).toEqual(['first', 'second'])

    session.resolvePrompt()
    ws.close()
  })

  test('queue_state is pushed to the client when prompts are queued and drained', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor, received } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: send two prompts; only the first should be in flight, the second should be visible in queue_state
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await new Promise((r) => setTimeout(r, 30))

    const queueStates = received.filter(
      (m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state',
    )
    expect(queueStates.length).toBeGreaterThan(0)
    const last = queueStates[queueStates.length - 1]!
    expect(last.pending.map((p) => p.text)).toEqual(['second'])

    session.resolvePrompt()
    await new Promise((r) => setTimeout(r, 20))
    session.resolvePrompt()
    ws.close()
  })

  test('queue_cancel removes a queued prompt before it drains', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor, received } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await new Promise((r) => setTimeout(r, 30))

    const queueStateBefore = received
      .filter((m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state')
      .at(-1)
    expect(queueStateBefore?.pending.map((p) => p.text)).toEqual(['second'])
    const queuedId = queueStateBefore!.pending[0]!.id

    // when: cancel the queued one
    ws.send(JSON.stringify({ type: 'queue_cancel', messageId: queuedId }))
    await new Promise((r) => setTimeout(r, 20))

    // then: queue is empty
    const queueStateAfter = received
      .filter((m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state')
      .at(-1)
    expect(queueStateAfter?.pending).toEqual([])

    // and: when first completes, second is NOT processed
    session.resolvePrompt()
    await new Promise((r) => setTimeout(r, 30))
    expect(session.promptCalls).toEqual(['first'])

    ws.close()
  })

  test('broadcast stream messages are forwarded to the client as notification', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'mood', value: 'happy' } })

    // then
    const msg = await waitFor((m) => m.type === 'notification')
    if (msg.type !== 'notification') throw new Error('unreachable')
    expect(msg.payload).toEqual({ kind: 'mood', value: 'happy' })

    ws.close()
  })

  test('stream messages targeted at a different sessionId are not delivered to this session', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: publish to a different session id
    stream.publish({
      target: { kind: 'session', sessionId: 'someone-else' },
      payload: { kind: 'prompt', text: 'not for us' },
    })
    await new Promise((r) => setTimeout(r, 20))

    // then: nothing reaches this session.prompt
    expect(session.promptCalls).toEqual([])

    ws.close()
  })

  test('an interrupt-delivery prompt aborts the in-flight prompt before sending the new one', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: first prompt starts
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(session.promptCalls).toEqual(['first'])
    expect(session.abortCalls).toBe(0)

    // when: interrupt-delivery prompt arrives
    ws.send(JSON.stringify({ type: 'prompt', text: 'urgent', delivery: 'interrupt' }))
    await new Promise((r) => setTimeout(r, 30))

    // then: abort was called, then second prompt was sent
    expect(session.abortCalls).toBeGreaterThanOrEqual(1)
    expect(session.promptCalls.includes('urgent')).toBe(true)

    session.resolvePrompt()
    ws.close()
  })

  test('close() unsubscribes from the stream so further publishes do not error', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.close()
    await new Promise((r) => setTimeout(r, 20))

    // when: publish a broadcast after close
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'noise' } })

    // then: no crash; the test passes if we get here
    expect(true).toBe(true)
  })
})

describe('createServer fires session.idle hook after every prompt completion', () => {
  function stubSessionFactory(opts: { transcriptPath?: string }): SessionFactory {
    return {
      sessionDir: () => '/tmp/test-sessions',
      createPersisted: () =>
        ({
          getSessionId: () => 'ses_fake',
          getSessionFile: () => opts.transcriptPath,
        }) as unknown as SessionManager,
    }
  }

  test('runSessionIdle is called once per successful prompt completion (with transcript path)', async () => {
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const idleEvents: { sessionId: string; parentTranscriptPath: string | undefined }[] = []
    const hooks = createHookBus()
    hooks.registerAll(
      'p',
      '/agent',
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.idle': (event) => {
          idleEvents.push({ sessionId: event.sessionId, parentTranscriptPath: event.parentTranscriptPath })
        },
      },
    )

    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/test-sessions/ses_fake.jsonl' }),
      agentDir: '/agent',
      pluginRegistry: emptyRegistry(),
      pluginHooks: hooks,
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')
    await new Promise((r) => setTimeout(r, 10))

    expect(idleEvents).toHaveLength(1)
    expect(idleEvents[0]?.sessionId).toBe('ses_fake')
    expect(idleEvents[0]?.parentTranscriptPath).toBe('/tmp/test-sessions/ses_fake.jsonl')
    ws.close()
  })

  test('runSessionIdle is called even when the prompt throws', async () => {
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const idleEvents: string[] = []
    const hooks = createHookBus()
    hooks.registerAll(
      'p',
      '/agent',
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.idle': (event) => {
          idleEvents.push(event.sessionId)
        },
      },
    )

    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/x.jsonl' }),
      agentDir: '/agent',
      pluginRegistry: emptyRegistry(),
      pluginHooks: hooks,
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.rejectPrompt(new Error('llm boom'))
    await waitFor((m) => m.type === 'error')
    await new Promise((r) => setTimeout(r, 10))

    expect(idleEvents).toHaveLength(1)
    ws.close()
  })

  test('completes a prompt cleanly when no plugin hooks are attached (no idle hook to fire)', async () => {
    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/x.jsonl' }),
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.resolvePrompt()
    const done = await waitFor((m) => m.type === 'done')

    expect(done.type).toBe('done')
    ws.close()
  })
})

describe('createServer surfaces LLM errors to logger', () => {
  function stubSessionFactory(): SessionFactory {
    return {
      sessionDir: () => '/tmp/test-sessions',
      createPersisted: () =>
        ({
          getSessionId: () => 'ses_fake',
          getSessionFile: () => undefined,
        }) as unknown as SessionManager,
    }
  }

  const silentLogger: ServerLogger = { info: () => {}, warn: () => {}, error: () => {} }

  test('logs to logger.error when session.prompt() throws in the drain-loop path (so typeclaw logs surfaces the failure)', async () => {
    const errors: string[] = []
    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory(),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.rejectPrompt(new Error('llm boom'))
    const errFrame = await waitFor((m) => m.type === 'error')

    if (errFrame.type !== 'error') throw new Error('unreachable')
    expect(errFrame.message).toBe('llm boom')
    expect(errors.some((e) => /\[server\] ses_fake: prompt failed: llm boom/.test(e))).toBe(true)
    ws.close()
  })

  test('logs to logger.error when session.prompt() throws in the fallback path (no stream)', async () => {
    const errors: string[] = []
    const session = createFakeSession()

    const { url } = await startWithSession(session, {
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    const { ws, waitFor } = await connect(url)
    const opened = await waitFor((m) => m.type === 'connected')
    if (opened.type !== 'connected') throw new Error('unreachable')

    ws.send(JSON.stringify({ type: 'prompt', text: 'hello' }))
    await new Promise((r) => setTimeout(r, 10))
    session.rejectPrompt(new Error('fallback boom'))
    const errFrame = await waitFor((m) => m.type === 'error')

    if (errFrame.type !== 'error') throw new Error('unreachable')
    expect(errFrame.message).toBe('fallback boom')
    expect(errors.some((e) => /\[server\] .+: prompt failed: fallback boom/.test(e))).toBe(true)
    ws.close()
  })

  test('logs to logger.error when the assistant message ends with stopReason: error (non-throwing upstream LLM failure)', async () => {
    const errors: string[] = []
    const session = createFakeSession()

    const { url } = await startWithSession(session, {
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'billing: account inactive' },
    } as unknown as Parameters<typeof session.emit>[0])

    const errFrame = await waitFor((m) => m.type === 'error')
    if (errFrame.type !== 'error') throw new Error('unreachable')
    expect(errFrame.message).toBe('billing: account inactive')
    expect(errors.some((e) => /\[server\] .+: LLM call failed: billing: account inactive/.test(e))).toBe(true)
    ws.close()
  })

  test('does not log when the assistant message ends with stopReason: aborted (user pressed Escape)', async () => {
    const errors: string[] = []
    const session = createFakeSession()

    const { url } = await startWithSession(session, {
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'aborted' },
    } as unknown as Parameters<typeof session.emit>[0])

    await new Promise((r) => setTimeout(r, 20))
    expect(errors).toEqual([])
    ws.close()
  })
})

describe('createServer plugin hooks', () => {
  test('fires session.start with the session id and agentDir on websocket open', async () => {
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const fired: { sessionId: string; agentDir: string }[] = []
    const hooks = createHookBus()
    hooks.registerAll(
      'p',
      '/agent',
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.start': (event) => {
          fired.push({ sessionId: event.sessionId, agentDir: event.agentDir })
        },
      },
    )

    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      pluginRegistry: emptyRegistry(),
      pluginHooks: hooks,
      agentDir: '/agent',
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    expect(fired).toHaveLength(1)
    expect(fired[0]?.agentDir).toBe('/agent')
    ws.close()
  })

  test('awaits session.end before resolving the close handler', async () => {
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const endResolve: { fn: (() => void) | null } = { fn: null }
    let ended = false
    const hooks = createHookBus()
    hooks.registerAll(
      'p',
      '/agent',
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.end': () =>
          new Promise<void>((resolve) => {
            endResolve.fn = () => {
              ended = true
              resolve()
            }
          }),
      },
    )

    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      pluginRegistry: emptyRegistry(),
      pluginHooks: hooks,
      agentDir: '/agent',
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(ended).toBe(false)
    endResolve.fn?.()
    await new Promise((r) => setTimeout(r, 30))
    expect(ended).toBe(true)
  })
})

describe('createServer session lifecycle', () => {
  test('disposes the underlying AgentSession on websocket close', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.close()
    await new Promise((r) => setTimeout(r, 20))

    expect(session.disposeCalls).toBe(1)
  })
})

describe('createServer scoped reload', () => {
  test('reload without scope runs reloadAll and returns every scope result', async () => {
    // given
    const { ReloadRegistry } = await import('@/reload')
    const reloadRegistry = new ReloadRegistry()
    reloadRegistry.register({
      scope: 'config',
      description: 'config',
      reload: async () => ({ scope: 'config', ok: true, summary: 'cfg ok' }),
    })
    reloadRegistry.register({
      scope: 'cron',
      description: 'cron',
      reload: async () => ({ scope: 'cron', ok: true, summary: 'cron ok' }),
    })

    const session = createFakeSession()
    const built = createServer({
      port: 0,
      reloadAll: () => reloadRegistry.reloadAll(),
      reloadRegistry,
      createSession: async () => session,
    }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'reload' }))
    const result = await waitFor((m) => m.type === 'reload_result')

    // then
    if (result.type !== 'reload_result') throw new Error('unreachable')
    expect(result.results.map((r) => r.scope)).toEqual(['config', 'cron'])
    ws.close()
  })

  test('reload with scope runs only that reloadable and returns a single result', async () => {
    // given
    const { ReloadRegistry } = await import('@/reload')
    const calls: string[] = []
    const reloadRegistry = new ReloadRegistry()
    reloadRegistry.register({
      scope: 'config',
      description: 'config',
      reload: async () => {
        calls.push('config')
        return { scope: 'config', ok: true, summary: 'cfg ok' }
      },
    })
    reloadRegistry.register({
      scope: 'cron',
      description: 'cron',
      reload: async () => {
        calls.push('cron')
        return { scope: 'cron', ok: true, summary: 'cron ok' }
      },
    })

    const session = createFakeSession()
    const built = createServer({
      port: 0,
      reloadAll: () => reloadRegistry.reloadAll(),
      reloadRegistry,
      createSession: async () => session,
    }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'reload', scope: 'cron' }))
    const result = await waitFor((m) => m.type === 'reload_result')

    // then
    if (result.type !== 'reload_result') throw new Error('unreachable')
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.scope).toBe('cron')
    expect(calls).toEqual(['cron'])
    ws.close()
  })

  test('reload with unknown scope returns a single failure result', async () => {
    // given
    const { ReloadRegistry } = await import('@/reload')
    const reloadRegistry = new ReloadRegistry()
    reloadRegistry.register({
      scope: 'config',
      description: 'config',
      reload: async () => ({ scope: 'config', ok: true, summary: 'cfg ok' }),
    })

    const session = createFakeSession()
    const built = createServer({
      port: 0,
      reloadAll: () => reloadRegistry.reloadAll(),
      reloadRegistry,
      createSession: async () => session,
    }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'reload', scope: 'no-such-scope' }))
    const result = await waitFor((m) => m.type === 'reload_result')

    // then
    if (result.type !== 'reload_result') throw new Error('unreachable')
    expect(result.results).toHaveLength(1)
    const first = result.results[0]
    expect(first?.scope).toBe('no-such-scope')
    expect(first?.ok).toBe(false)
    ws.close()
  })
})

describe('createServer plugin-command dispatch', () => {
  function makeFakeRunner(): {
    runner: CommandRunner
    starts: { callId: string; name: string }[]
    outbound: CommandOutbound | null
  } {
    const ref: {
      runner: CommandRunner
      starts: { callId: string; name: string }[]
      outbound: CommandOutbound | null
    } = {
      runner: null as unknown as CommandRunner,
      starts: [],
      outbound: null,
    }
    return ref
  }

  function buildRunnerFactory(state: ReturnType<typeof makeFakeRunner>): (outbound: CommandOutbound) => CommandRunner {
    return (outbound) => {
      state.outbound = outbound
      const runner: CommandRunner = {
        start(msg) {
          state.starts.push({ callId: msg.callId, name: msg.name })
        },
        feedStdin() {},
        endStdin() {},
        abort() {},
        abortForOwner() {},
        inFlightCount: () => 0,
      }
      state.runner = runner
      return runner
    }
  }

  test('rejects a duplicate callId at the WS layer before the runner is touched', async () => {
    const session = createFakeSession()
    const state = makeFakeRunner()
    const { url } = await startWithSession(session, { commandRunnerFactory: buildRunnerFactory(state) })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'exec_command', callId: 'dup-1', name: 'noop', args: {} }))
    ws.send(JSON.stringify({ type: 'exec_command', callId: 'dup-1', name: 'noop', args: {} }))

    const errorFrame = await waitFor(
      (m) => m.type === 'command_error' && 'callId' in m && m.callId === 'dup-1' && /already in flight/.test(m.message),
    )
    expect(errorFrame.type).toBe('command_error')

    expect(state.starts.length).toBe(1)
    expect(state.starts[0]?.callId).toBe('dup-1')

    ws.close()
  })

  test('/commands path dispatches exec_command WITHOUT sending a `connected` frame', async () => {
    // Tracks how many times the session factory was hit. A connection to
    // the /commands path must not create an AgentSession, so this counter
    // stays at 0 across the whole interaction.
    let sessionFactoryHits = 0
    const session = createFakeSession()
    const state = makeFakeRunner()

    const built = createServer({
      port: 0,
      createSession: async () => {
        sessionFactoryHits++
        return session
      },
      commandRunnerFactory: buildRunnerFactory(state),
    }).start()
    server = built

    const { ws, received } = await connect(`ws://localhost:${built.port}/commands`)

    ws.send(JSON.stringify({ type: 'exec_command', callId: 'cmd-1', name: 'noop', args: {} }))
    // Give the server a tick to dispatch synchronously; no `connected` frame
    // means waitFor would just hang, so we sleep briefly and then assert.
    await new Promise((r) => setTimeout(r, 100))

    expect(state.starts.length).toBe(1)
    expect(state.starts[0]?.callId).toBe('cmd-1')
    expect(sessionFactoryHits).toBe(0)
    expect(received.some((m) => m.type === 'connected')).toBe(false)

    ws.close()
  })

  test('/commands path rejects non-command ClientMessage frames silently (no error frame, no session)', async () => {
    let sessionFactoryHits = 0
    const session = createFakeSession()
    const state = makeFakeRunner()

    const built = createServer({
      port: 0,
      createSession: async () => {
        sessionFactoryHits++
        return session
      },
      commandRunnerFactory: buildRunnerFactory(state),
    }).start()
    server = built

    const { ws, received } = await connect(`ws://localhost:${built.port}/commands`)

    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))
    await new Promise((r) => setTimeout(r, 50))

    expect(received.length).toBe(0)
    expect(sessionFactoryHits).toBe(0)

    ws.close()
  })

  test('command_stdin / command_stdin_end / command_abort route to the runner with the right callId', async () => {
    const session = createFakeSession()
    const stdinFeeds: { callId: string; chunk: string }[] = []
    const stdinEnds: string[] = []
    const aborts: { callId: string; reason: string }[] = []
    const built = createServer({
      port: 0,
      createSession: async () => session,
      commandRunnerFactory: (_outbound) => ({
        start() {},
        feedStdin(callId, chunk) {
          stdinFeeds.push({ callId, chunk })
        },
        endStdin(callId) {
          stdinEnds.push(callId)
        },
        abort(callId, reason) {
          aborts.push({ callId, reason })
        },
        abortForOwner() {},
        inFlightCount: () => 0,
      }),
    }).start()
    server = built

    const { ws } = await connect(`ws://localhost:${built.port}/commands`)
    ws.send(JSON.stringify({ type: 'exec_command', callId: 'k', name: 'foo', args: {} }))
    ws.send(JSON.stringify({ type: 'command_stdin', callId: 'k', chunk: btoa('payload') }))
    ws.send(JSON.stringify({ type: 'command_stdin_end', callId: 'k' }))
    ws.send(JSON.stringify({ type: 'command_abort', callId: 'k', reason: 'manual' }))
    await new Promise((r) => setTimeout(r, 80))

    expect(stdinFeeds).toEqual([{ callId: 'k', chunk: btoa('payload') }])
    expect(stdinEnds).toEqual(['k'])
    expect(aborts).toEqual([{ callId: 'k', reason: 'manual' }])

    ws.close()
  })

  test('exec_command without commandRunnerFactory replies with command_error + command_exit', async () => {
    const session = createFakeSession()
    const built = createServer({
      port: 0,
      createSession: async () => session,
    }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}/commands`)

    ws.send(JSON.stringify({ type: 'exec_command', callId: 'fb', name: 'whatever', args: {} }))

    const errFrame = await waitFor((m) => m.type === 'command_error' && 'callId' in m && m.callId === 'fb')
    expect(errFrame.type).toBe('command_error')
    if (errFrame.type === 'command_error') {
      expect(errFrame.message).toMatch(/not enabled/)
    }
    const exitFrame = await waitFor((m) => m.type === 'command_exit' && 'callId' in m && m.callId === 'fb')
    if (exitFrame.type === 'command_exit') {
      expect(exitFrame.code).toBe(1)
    }

    ws.close()
  })

  test('exec_command parentOriginJson is parsed and forwarded to the runner', async () => {
    const seenStarts: { callId: string; parentOrigin?: unknown }[] = []
    const session = createFakeSession()
    const built = createServer({
      port: 0,
      createSession: async () => session,
      commandRunnerFactory: () => ({
        start(msg) {
          seenStarts.push({ callId: msg.callId, parentOrigin: msg.parentOrigin })
        },
        feedStdin() {},
        endStdin() {},
        abort() {},
        abortForOwner() {},
        inFlightCount: () => 0,
      }),
    }).start()
    server = built

    const { ws } = await connect(`ws://localhost:${built.port}/commands`)

    const parentOrigin = { kind: 'cron', jobId: 'nightly', jobKind: 'exec', scheduledByRole: 'member' }
    ws.send(
      JSON.stringify({
        type: 'exec_command',
        callId: 'p-1',
        name: 'cmd',
        args: {},
        parentOriginJson: JSON.stringify(parentOrigin),
      }),
    )
    await new Promise((r) => setTimeout(r, 80))

    expect(seenStarts.length).toBe(1)
    expect(seenStarts[0]?.parentOrigin).toEqual(parentOrigin)
    ws.close()
  })

  test('exec_command with malformed parentOriginJson falls back to undefined parentOrigin', async () => {
    const seenStarts: { callId: string; parentOrigin?: unknown }[] = []
    const session = createFakeSession()
    const built = createServer({
      port: 0,
      createSession: async () => session,
      commandRunnerFactory: () => ({
        start(msg) {
          seenStarts.push({ callId: msg.callId, parentOrigin: msg.parentOrigin })
        },
        feedStdin() {},
        endStdin() {},
        abort() {},
        abortForOwner() {},
        inFlightCount: () => 0,
      }),
    }).start()
    server = built

    const { ws } = await connect(`ws://localhost:${built.port}/commands`)
    ws.send(
      JSON.stringify({
        type: 'exec_command',
        callId: 'p-2',
        name: 'cmd',
        args: {},
        parentOriginJson: 'not-valid-json',
      }),
    )
    await new Promise((r) => setTimeout(r, 80))

    expect(seenStarts.length).toBe(1)
    expect(seenStarts[0]?.parentOrigin).toBeUndefined()
    ws.close()
  })

  test('ws-close aborts every in-flight command tied to the closed connection', async () => {
    let abortedCount = 0
    const session = createFakeSession()
    const built = createServer({
      port: 0,
      createSession: async () => session,
      commandRunnerFactory: () => ({
        start() {},
        feedStdin() {},
        endStdin() {},
        abort() {},
        abortForOwner() {
          abortedCount++
        },
        inFlightCount: () => 0,
      }),
    }).start()
    server = built

    const { ws } = await connect(`ws://localhost:${built.port}/commands`)
    ws.send(JSON.stringify({ type: 'exec_command', callId: 'will-die', name: 'noop', args: {} }))
    await new Promise((r) => setTimeout(r, 50))
    ws.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(abortedCount).toBe(1)
  })
})

describe('safeWsSend', () => {
  test('returns true when ws.send succeeds and forwards the JSON-serialized message', () => {
    const sent: string[] = []
    const fakeWs = {
      send: (data: string) => {
        sent.push(data)
      },
    }
    const ok = safeWsSend(fakeWs, { type: 'done' })
    expect(ok).toBe(true)
    expect(sent).toEqual(['{"type":"done"}'])
  })

  test('returns false and swallows the error when ws.send throws (closing-ws race)', () => {
    const fakeWs = {
      send: () => {
        throw new Error('WebSocket is closed')
      },
    }
    const ok = safeWsSend(fakeWs, { type: 'done' })
    expect(ok).toBe(false)
  })
})
