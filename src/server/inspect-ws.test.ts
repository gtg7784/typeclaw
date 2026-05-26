import { afterEach, describe, expect, test } from 'bun:test'

import type { AgentSession } from '@/agent'
import { LiveSessionRegistry } from '@/agent/live-sessions'
import type { InspectServerMessage } from '@/shared'
import { createStream } from '@/stream'

import { createServer } from './index'

let server: ReturnType<ReturnType<typeof createServer>['start']> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

type FakeAgent = AgentSession & {
  emit: (event: unknown) => void
}

function createFakeAgent(): FakeAgent {
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
  return fake as unknown as FakeAgent
}

async function startServer(
  opts: {
    liveSessionRegistry?: LiveSessionRegistry
    stream?: ReturnType<typeof createStream>
    tuiToken?: string
  } = {},
): Promise<{ url: string }> {
  const built = createServer({
    port: 0,
    createSession: async () => createFakeAgent(),
    ...(opts.liveSessionRegistry !== undefined ? { liveSessionRegistry: opts.liveSessionRegistry } : {}),
    ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
    ...(opts.tuiToken !== undefined ? { tuiToken: opts.tuiToken } : {}),
  }).start()
  server = built
  return { url: `ws://localhost:${built.port}/inspect` }
}

async function connectInspect(url: string): Promise<{
  ws: WebSocket
  received: InspectServerMessage[]
  waitFor: (predicate: (msg: InspectServerMessage) => boolean, timeoutMs?: number) => Promise<InspectServerMessage>
}> {
  const ws = new WebSocket(url)
  const received: InspectServerMessage[] = []
  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)) as InspectServerMessage)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (err) => reject(err), { once: true })
  })
  const waitFor = async (
    predicate: (msg: InspectServerMessage) => boolean,
    timeoutMs = 1000,
  ): Promise<InspectServerMessage> => {
    const existing = received.find(predicate)
    if (existing) return existing
    return await new Promise<InspectServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for inspect frame')), timeoutMs)
      const onMessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as InspectServerMessage
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

describe('/inspect WS handler', () => {
  test('subscribe to a live session: ack carries sessionLive=true and AgentSession events forward as frames', async () => {
    const registry = new LiveSessionRegistry()
    const session = createFakeAgent()
    registry.register({ sessionId: 'ses_live', session })

    const { url } = await startServer({ liveSessionRegistry: registry })
    const { ws, waitFor } = await connectInspect(url)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_live' }))
    const ack = await waitFor((m) => m.type === 'subscribed')
    if (ack.type !== 'subscribed') throw new Error('unreachable')
    expect(ack.sessionId).toBe('ses_live')
    expect(ack.sessionLive).toBe(true)

    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'src/auth.ts' },
    })
    const start = await waitFor((m) => m.type === 'frame' && m.payload.kind === 'tool_start')
    if (start.type !== 'frame' || start.payload.kind !== 'tool_start') throw new Error('unreachable')
    expect(start.payload.sessionId).toBe('ses_live')
    expect(start.payload.name).toBe('read')
    expect(start.payload.args).toEqual({ path: 'src/auth.ts' })

    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'read',
      result: 'file contents',
      isError: false,
    })
    const end = await waitFor((m) => m.type === 'frame' && m.payload.kind === 'tool_end')
    if (end.type !== 'frame' || end.payload.kind !== 'tool_end') throw new Error('unreachable')
    expect(end.payload.name).toBe('read')
    expect(end.payload.isError).toBe(false)
    expect(typeof end.payload.durationMs).toBe('number')

    ws.close()
  })

  test('subscribe to a non-live session: ack carries sessionLive=false and no agent frames arrive', async () => {
    const registry = new LiveSessionRegistry()
    const { url } = await startServer({ liveSessionRegistry: registry })
    const { ws, waitFor } = await connectInspect(url)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_dead' }))
    const ack = await waitFor((m) => m.type === 'subscribed')
    if (ack.type !== 'subscribed') throw new Error('unreachable')
    expect(ack.sessionLive).toBe(false)
    ws.close()
  })

  test('text_delta events forward as frames', async () => {
    const registry = new LiveSessionRegistry()
    const session = createFakeAgent()
    registry.register({ sessionId: 'ses_live', session })
    const { url } = await startServer({ liveSessionRegistry: registry })
    const { ws, waitFor } = await connectInspect(url)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_live' }))
    await waitFor((m) => m.type === 'subscribed')

    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
    const frame = await waitFor((m) => m.type === 'frame' && m.payload.kind === 'text_delta')
    if (frame.type !== 'frame' || frame.payload.kind !== 'text_delta') throw new Error('unreachable')
    expect(frame.payload.delta).toBe('hello')
    ws.close()
  })

  test('thinking_delta and thinking_end events forward as frames', async () => {
    const registry = new LiveSessionRegistry()
    const session = createFakeAgent()
    registry.register({ sessionId: 'ses_live', session })
    const { url } = await startServer({ liveSessionRegistry: registry })
    const { ws, waitFor } = await connectInspect(url)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_live' }))
    await waitFor((m) => m.type === 'subscribed')

    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'planning ' } })
    const deltaFrame = await waitFor((m) => m.type === 'frame' && m.payload.kind === 'thinking_delta')
    if (deltaFrame.type !== 'frame' || deltaFrame.payload.kind !== 'thinking_delta') throw new Error('unreachable')
    expect(deltaFrame.payload.delta).toBe('planning ')

    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', content: 'planning ahead' },
    })
    const endFrame = await waitFor((m) => m.type === 'frame' && m.payload.kind === 'thinking_end')
    if (endFrame.type !== 'frame' || endFrame.payload.kind !== 'thinking_end') throw new Error('unreachable')
    expect(endFrame.payload.text).toBe('planning ahead')
    ws.close()
  })

  test('message_end events forward as frames with usage normalised', async () => {
    const registry = new LiveSessionRegistry()
    const session = createFakeAgent()
    registry.register({ sessionId: 'ses_live', session })
    const { url } = await startServer({ liveSessionRegistry: registry })
    const { ws, waitFor } = await connectInspect(url)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_live' }))
    await waitFor((m) => m.type === 'subscribed')

    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Fixed.' }],
        provider: 'fireworks',
        model: 'kimi-k2',
        stopReason: 'end_turn',
        usage: {
          input: 120,
          output: 80,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200,
          cost: { total: 0.0019 },
        },
      },
    })
    const frame = await waitFor((m) => m.type === 'frame' && m.payload.kind === 'message_end')
    if (frame.type !== 'frame' || frame.payload.kind !== 'message_end') throw new Error('unreachable')
    expect(frame.payload.usage).toEqual({
      input: 120,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 200,
      cost: 0.0019,
    })
    expect(frame.payload.stopReason).toBe('end_turn')
    ws.close()
  })

  test('Stream broadcast events forward as broadcast frames', async () => {
    const stream = createStream()
    const registry = new LiveSessionRegistry()
    const { url } = await startServer({ liveSessionRegistry: registry, stream })
    const { ws, waitFor } = await connectInspect(url)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_x' }))
    await waitFor((m) => m.type === 'subscribed')

    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'subagent.completed', ok: true } })
    const frame = await waitFor((m) => m.type === 'frame' && m.payload.kind === 'broadcast')
    if (frame.type !== 'frame' || frame.payload.kind !== 'broadcast') throw new Error('unreachable')
    expect(frame.payload.payload).toEqual({ kind: 'subagent.completed', ok: true })
    ws.close()
  })

  test('Stream cron events forward as cron-fire frames with the jobId surfaced', async () => {
    const stream = createStream()
    const { url } = await startServer({ stream })
    const { ws, waitFor } = await connectInspect(url)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_anything' }))
    await waitFor((m) => m.type === 'subscribed')

    stream.publish({ target: { kind: 'cron', jobId: 'daily-backup' }, payload: { schedule: '0 3 * * *' } })
    const frame = await waitFor((m) => m.type === 'frame' && m.payload.kind === 'cron-fire')
    if (frame.type !== 'frame' || frame.payload.kind !== 'cron-fire') throw new Error('unreachable')
    expect(frame.payload.jobId).toBe('daily-backup')
    ws.close()
  })

  test('sinceMs backfills broadcasts and cron events from the ring buffer before live tail starts', async () => {
    const stream = createStream()
    const t0 = Date.now()
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'old-event' } })

    const { url } = await startServer({ stream })
    const { ws, waitFor, received } = await connectInspect(url)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_x', sinceMs: t0 - 1 }))
    await waitFor((m) => m.type === 'subscribed')

    const backfilled = received.find(
      (m): m is Extract<InspectServerMessage, { type: 'frame' }> =>
        m.type === 'frame' && m.payload.kind === 'broadcast',
    )
    expect(backfilled).toBeDefined()
    if (backfilled?.type !== 'frame' || backfilled.payload.kind !== 'broadcast') throw new Error('unreachable')
    expect(backfilled.payload.payload).toEqual({ kind: 'old-event' })
    ws.close()
  })

  test('invalid JSON subscription is rejected with an error frame and the socket closes', async () => {
    const { url } = await startServer()
    const ws = new WebSocket(url)
    await new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true }))
    const errorPromise = new Promise<InspectServerMessage>((resolve) => {
      ws.addEventListener(
        'message',
        (e) => {
          const msg = JSON.parse(String(e.data)) as InspectServerMessage
          if (msg.type === 'error') resolve(msg)
        },
        { once: true },
      )
    })
    ws.send('not json {{{')
    const err = await errorPromise
    if (err.type !== 'error') throw new Error('unreachable')
    expect(err.message).toContain('JSON')
  })

  test('missing sessionId is rejected with an error frame', async () => {
    const { url } = await startServer()
    const ws = new WebSocket(url)
    await new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true }))
    const errorPromise = new Promise<InspectServerMessage>((resolve) => {
      ws.addEventListener(
        'message',
        (e) => {
          const msg = JSON.parse(String(e.data)) as InspectServerMessage
          if (msg.type === 'error') resolve(msg)
        },
        { once: true },
      )
    })
    ws.send(JSON.stringify({ type: 'subscribe' }))
    const err = await errorPromise
    if (err.type !== 'error') throw new Error('unreachable')
    expect(err.message).toContain('invalid')
  })

  test('rejects websocket upgrades without the TUI token when one is configured', async () => {
    const { url } = await startServer({ tuiToken: 'secret' })
    const ws = new WebSocket(url)
    await new Promise<void>((resolve) => ws.addEventListener('close', () => resolve(), { once: true }))
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  test('accepts websocket upgrades with the correct TUI token', async () => {
    const registry = new LiveSessionRegistry()
    const session = createFakeAgent()
    registry.register({ sessionId: 'ses_live', session })
    const { url } = await startServer({ liveSessionRegistry: registry, tuiToken: 'secret' })
    const { ws, waitFor } = await connectInspect(`${url}?token=secret`)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'ses_live' }))
    const ack = await waitFor((m) => m.type === 'subscribed')
    expect(ack.type).toBe('subscribed')
    ws.close()
  })
})
