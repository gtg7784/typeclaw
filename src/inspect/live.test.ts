import { afterEach, describe, expect, test } from 'bun:test'

import type { AgentSession } from '@/agent'
import { LiveSessionRegistry } from '@/agent/live-sessions'
import { createServer } from '@/server'
import { createStream } from '@/stream'

import { streamLive } from './live'
import type { InspectEvent } from './types'

let server: ReturnType<ReturnType<typeof createServer>['start']> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

function createFakeAgent(): AgentSession & { emit: (event: unknown) => void } {
  const subscribers = new Set<(event: unknown) => void>()
  const fake = {
    subscribe: (fn: (event: unknown) => void) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
    emit: (event: unknown) => {
      for (const fn of subscribers) fn(event)
    },
  }
  return fake as unknown as AgentSession & { emit: (event: unknown) => void }
}

async function startServer(
  opts: {
    registry?: LiveSessionRegistry
    stream?: ReturnType<typeof createStream>
  } = {},
): Promise<{ url: string }> {
  const built = createServer({
    port: 0,
    createSession: async () => createFakeAgent(),
    ...(opts.registry !== undefined ? { liveSessionRegistry: opts.registry } : {}),
    ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
  }).start()
  server = built
  return { url: `ws://localhost:${built.port}/inspect` }
}

async function collectN(gen: AsyncIterable<InspectEvent>, n: number): Promise<InspectEvent[]> {
  const out: InspectEvent[] = []
  for await (const ev of gen) {
    out.push(ev)
    if (out.length >= n) break
  }
  return out
}

describe('streamLive — live session events', () => {
  test('tool start/end events arrive as InspectEvent.tool start/end frames', async () => {
    const registry = new LiveSessionRegistry()
    const session = createFakeAgent()
    registry.register({ sessionId: 'ses_a', session })
    const { url } = await startServer({ registry })

    const ctrl = new AbortController()
    const liveFlags: boolean[] = []
    const gen = streamLive({
      url,
      sessionId: 'ses_a',
      signal: ctrl.signal,
      onSubscribed: (live) => {
        liveFlags.push(live)
      },
    })

    setTimeout(() => {
      session.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'x' } })
      session.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: 'ok', isError: false })
    }, 50)

    const events = await collectN(gen, 2)
    ctrl.abort()
    expect(liveFlags).toEqual([true])
    expect(events).toHaveLength(2)
    const start = events[0]!
    const end = events[1]!
    if (start.cat !== 'tool' || start.phase !== 'start') throw new Error('expected tool start')
    if (end.cat !== 'tool' || end.phase !== 'end') throw new Error('expected tool end')
    expect(start.name).toBe('read')
    expect(end.name).toBe('read')
    expect(end.isError).toBe(false)
  })

  test('text_delta accumulates until message_end then emits one assistant event', async () => {
    const registry = new LiveSessionRegistry()
    const session = createFakeAgent()
    registry.register({ sessionId: 'ses_a', session })
    const { url } = await startServer({ registry })

    const ctrl = new AbortController()
    const gen = streamLive({ url, sessionId: 'ses_a', signal: ctrl.signal })

    setTimeout(() => {
      session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } })
      session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } })
      session.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
          provider: 'p',
          model: 'm',
          stopReason: 'end_turn',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
        },
      })
    }, 50)

    const events = await collectN(gen, 1)
    ctrl.abort()
    const assist = events[0]!
    if (assist.cat !== 'assistant') throw new Error('expected assistant')
    expect(assist.text).toBe('Hello world')
    expect(assist.provider).toBe('p')
    expect(assist.model).toBe('m')
  })

  test('broadcast events surface as InspectEvent.broadcast', async () => {
    const stream = createStream()
    const { url } = await startServer({ stream })
    const ctrl = new AbortController()
    const gen = streamLive({ url, sessionId: 'ses_anything', signal: ctrl.signal })

    setTimeout(() => {
      stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'subagent.completed', ok: true } })
    }, 50)

    const events = await collectN(gen, 1)
    ctrl.abort()
    const ev = events[0]!
    if (ev.cat !== 'broadcast') throw new Error('expected broadcast')
    expect(ev.payload).toEqual({ kind: 'subagent.completed', ok: true })
  })

  test('channel-inbound broadcasts surface as InspectEvent.inbound with channel coords', async () => {
    const stream = createStream()
    const { url } = await startServer({ stream })
    const ctrl = new AbortController()
    const gen = streamLive({ url, sessionId: 'ses_anything', signal: ctrl.signal })

    setTimeout(() => {
      stream.publish({
        target: { kind: 'broadcast' },
        payload: {
          kind: 'channel-inbound',
          adapter: 'slack',
          workspace: 'acme',
          chat: 'C12345',
          thread: null,
          authorId: 'U_alice',
          authorName: 'alice',
          authorIsBot: false,
          isDm: false,
          isBotMention: true,
          text: 'hey bot',
          externalMessageId: 'm1',
          ts: 1_700_000_000_000,
          decision: 'engage',
        },
      })
    }, 50)

    const events = await collectN(gen, 1)
    ctrl.abort()
    const ev = events[0]!
    if (ev.cat !== 'inbound') throw new Error('expected inbound')
    expect(ev.adapter).toBe('slack')
    expect(ev.workspace).toBe('acme')
    expect(ev.chat).toBe('C12345')
    expect(ev.authorName).toBe('alice')
    expect(ev.text).toBe('hey bot')
    expect(ev.decision).toBe('engage')
    expect(ev.isBotMention).toBe(true)
    expect(ev.ts).toBe(1_700_000_000_000)
  })

  test('channel-inbound broadcast with malformed payload falls through as generic broadcast', async () => {
    const stream = createStream()
    const { url } = await startServer({ stream })
    const ctrl = new AbortController()
    const gen = streamLive({ url, sessionId: 'ses_anything', signal: ctrl.signal })

    setTimeout(() => {
      stream.publish({
        target: { kind: 'broadcast' },
        payload: { kind: 'channel-inbound', adapter: 'slack' },
      })
    }, 50)

    const events = await collectN(gen, 1)
    ctrl.abort()
    const ev = events[0]!
    if (ev.cat !== 'broadcast') throw new Error('expected broadcast (malformed inbound falls back)')
  })

  test('inbound published before subscribe is backfilled via sinceMs', async () => {
    const stream = createStream()
    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'channel-inbound',
        adapter: 'discord',
        workspace: '9999',
        chat: '8888',
        thread: null,
        authorId: 'U1',
        authorName: 'bob',
        authorIsBot: false,
        isDm: false,
        isBotMention: true,
        text: 'historical',
        externalMessageId: 'm0',
        ts: 0,
        decision: 'engage',
      },
    })

    const { url } = await startServer({ stream })
    const ctrl = new AbortController()
    const gen = streamLive({ url, sessionId: 'ses_anything', sinceMs: 0, signal: ctrl.signal })

    const events = await collectN(gen, 1)
    ctrl.abort()
    const ev = events[0]!
    if (ev.cat !== 'inbound') throw new Error('expected inbound from backfill')
    expect(ev.text).toBe('historical')
  })

  test('cron-fire events surface as InspectEvent.cron-fire with the jobId', async () => {
    const stream = createStream()
    const { url } = await startServer({ stream })
    const ctrl = new AbortController()
    const gen = streamLive({ url, sessionId: 'ses_anything', signal: ctrl.signal })

    setTimeout(() => {
      stream.publish({ target: { kind: 'cron', jobId: 'daily-backup' }, payload: { schedule: '0 3 * * *' } })
    }, 50)

    const events = await collectN(gen, 1)
    ctrl.abort()
    const ev = events[0]!
    if (ev.cat !== 'cron-fire') throw new Error('expected cron-fire')
    expect(ev.jobId).toBe('daily-backup')
  })

  test('subscribed callback reports sessionLive=false when registry is empty', async () => {
    const { url } = await startServer()
    const ctrl = new AbortController()
    const liveFlags: boolean[] = []
    const gen = streamLive({
      url,
      sessionId: 'ses_dead',
      signal: ctrl.signal,
      onSubscribed: (live) => {
        liveFlags.push(live)
      },
    })
    setTimeout(() => ctrl.abort(), 100)
    for await (const _ of gen) {
      void _
    }
    expect(liveFlags).toEqual([false])
  })

  test('aborting the signal closes the WS and ends the generator cleanly', async () => {
    const registry = new LiveSessionRegistry()
    const session = createFakeAgent()
    registry.register({ sessionId: 'ses_a', session })
    const { url } = await startServer({ registry })

    const ctrl = new AbortController()
    const gen = streamLive({ url, sessionId: 'ses_a', signal: ctrl.signal })

    setTimeout(() => ctrl.abort(), 50)
    const events: InspectEvent[] = []
    for await (const ev of gen) events.push(ev)
    expect(events).toEqual([])
  })

  test('error frame from the server surfaces as a thrown error', async () => {
    const { url } = await startServer()
    const ctrl = new AbortController()
    const gen = streamLive({ url, sessionId: '', signal: ctrl.signal })

    let caught: unknown = null
    try {
      for await (const _ of gen) void _
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(String((caught as Error).message)).toContain('invalid')
  })

  test('unknown server message types are ignored without crashing', async () => {
    // Forward-compat: a future server may add new top-level message `type`
    // values. The client must not crash when it sees one — especially since
    // such a message will not carry the `payload` field that `frame` carries.
    // Regression for: TypeError: undefined is not an object (evaluating 'payload.kind')
    const FakeWS = makeFakeWebSocket([
      { type: 'subscribed', sessionId: 'ses_a', sessionLive: true },
      { type: 'future_unknown_kind', whatever: 'data' },
      {
        type: 'frame',
        ts: 1,
        payload: { kind: 'broadcast', payload: { ok: true } },
      },
    ])

    const ctrl = new AbortController()
    const gen = streamLive({
      url: 'ws://unused',
      sessionId: 'ses_a',
      signal: ctrl.signal,
      WebSocketImpl: FakeWS,
    })

    const events = await collectN(gen, 1)
    ctrl.abort()
    const ev = events[0]!
    if (ev.cat !== 'broadcast') throw new Error('expected broadcast')
    expect(ev.payload).toEqual({ ok: true })
  })
})

// Hand-rolled fake WebSocket that delivers a scripted sequence of server
// messages immediately after subscribe. Used to drive client-side branches
// (unknown server `type` values, malformed frames) that real servers don't
// produce in normal operation.
function makeFakeWebSocket(scripted: unknown[]): typeof WebSocket {
  class FakeWS {
    readonly url: string
    readyState = 0
    private readonly listeners = new Map<string, Set<(e: unknown) => void>>()

    constructor(url: string) {
      this.url = url
      queueMicrotask(() => {
        this.readyState = 1
        this.dispatch('open', {})
      })
    }

    addEventListener(type: string, fn: (e: unknown) => void, _opts?: unknown): void {
      let set = this.listeners.get(type)
      if (set === undefined) {
        set = new Set()
        this.listeners.set(type, set)
      }
      set.add(fn)
    }

    removeEventListener(type: string, fn: (e: unknown) => void): void {
      this.listeners.get(type)?.delete(fn)
    }

    send(_data: string): void {
      // After the client subscribes, deliver the scripted messages.
      for (const msg of scripted) {
        queueMicrotask(() => {
          this.dispatch('message', { data: JSON.stringify(msg) })
        })
      }
    }

    close(): void {
      this.readyState = 3
      queueMicrotask(() => this.dispatch('close', {}))
    }

    private dispatch(type: string, event: unknown): void {
      const set = this.listeners.get(type)
      if (set === undefined) return
      for (const fn of set) fn(event)
    }
  }
  return FakeWS as unknown as typeof WebSocket
}
