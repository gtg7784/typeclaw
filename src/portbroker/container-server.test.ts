import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  createContainerBroker,
  type BrokerSocket,
  type UpstreamConnection,
  type UpstreamHandlers,
} from './container-server'
import type { ForwardRequestEvent } from './forward-request-bus'
import { decodeBytes, encodeBytes, type ContainerToHostd, type HostdToContainer } from './protocol'

type FakeSocket = BrokerSocket & {
  outbox: ContainerToHostd[]
  closeReason: string | null
  closeCode: number | null
}

function makeFakeSocket(): FakeSocket {
  const outbox: ContainerToHostd[] = []
  let closeReason: string | null = null
  let closeCode: number | null = null
  return {
    data: { kind: 'portbroker', authed: false } as { kind: 'portbroker'; authed: boolean },
    outbox,
    get closeReason() {
      return closeReason
    },
    get closeCode() {
      return closeCode
    },
    send(payload: string | Buffer | ArrayBuffer) {
      const text = typeof payload === 'string' ? payload : Buffer.from(payload as ArrayBuffer).toString('utf8')
      outbox.push(JSON.parse(text) as ContainerToHostd)
      return text.length
    },
    close(code?: number, reason?: string) {
      closeCode = code ?? null
      closeReason = reason ?? null
    },
  } as unknown as FakeSocket
}

function dispatch(
  broker: ReturnType<typeof createContainerBroker>,
  ws: FakeSocket,
  msg: HostdToContainer,
): Promise<void> {
  return broker.message(ws, JSON.stringify(msg))
}

describe('createContainerBroker auth', () => {
  test('rejects non-hello first message', async () => {
    const broker = createContainerBroker({ expectedToken: 'tok-1' })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'port-watch-subscribe' })
    expect(ws.outbox[0]).toEqual({ type: 'broker-hello-nack', reason: 'expected broker-hello first' })
    expect(ws.closeCode).toBe(1008)
  })

  test('rejects hello with wrong token', async () => {
    const broker = createContainerBroker({ expectedToken: 'tok-1' })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 'wrong' })
    expect(ws.outbox[0]).toEqual({ type: 'broker-hello-nack', reason: 'invalid token' })
    expect(ws.closeCode).toBe(1008)
  })

  test('accepts hello with correct token', async () => {
    const broker = createContainerBroker({ expectedToken: 'tok-1' })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 'tok-1' })
    expect(ws.outbox[0]).toEqual({ type: 'broker-hello-ack' })
    expect(ws.closeCode).toBe(null)
  })
})

describe('createContainerBroker port watcher', () => {
  let snapshots: string[]
  let cursor: number

  const reader = async (): Promise<string> => {
    const out = snapshots[cursor] ?? snapshots[snapshots.length - 1] ?? ''
    cursor = Math.min(cursor + 1, snapshots.length - 1)
    return out
  }

  async function waitFor(
    condition: () => boolean,
    label: string,
    { timeoutMs = 2000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (condition()) return
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  beforeEach(() => {
    snapshots = []
    cursor = 0
  })

  test('subscribe sends a snapshot of current LISTEN ports', async () => {
    snapshots = [`   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`]
    const broker = createContainerBroker({ expectedToken: 't', readProcNetTcp: reader })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'port-watch-subscribe' })
    const snap = ws.outbox.find((m) => m.type === 'port-listen-snapshot') as Extract<
      ContainerToHostd,
      { type: 'port-listen-snapshot' }
    >
    expect(snap.ports).toEqual([{ port: 5173, bindAddr: '0.0.0.0' }])
    broker.close(ws)
  })

  test('emits port-listen-opened/closed across polling ticks', async () => {
    snapshots = [``, `   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`, ``]
    const broker = createContainerBroker({ expectedToken: 't', readProcNetTcp: reader, pollIntervalMs: 5 })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'port-watch-subscribe' })
    const deltaEvents = (): ContainerToHostd[] =>
      ws.outbox.filter((m) => m.type === 'port-listen-opened' || m.type === 'port-listen-closed')
    await waitFor(() => deltaEvents().length >= 2, 'opened and closed port-listen delta events')
    broker.close(ws)
    const events = deltaEvents()
    expect(events[0]).toEqual({ type: 'port-listen-opened', port: 5173, bindAddr: '0.0.0.0' })
    expect(events.at(-1)).toEqual({ type: 'port-listen-closed', port: 5173 })
  })

  test('unsubscribe stops the polling timer', async () => {
    snapshots = [`   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`]
    const broker = createContainerBroker({ expectedToken: 't', readProcNetTcp: reader, pollIntervalMs: 5 })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'port-watch-subscribe' })
    // Wait until startWatcher's initial snapshot has been emitted so we know
    // setInterval has actually been scheduled before we call unsubscribe.
    // Without this anchor, a CI runner that starves setInterval would let the
    // outbox grow after the assertion window — but only because polling never
    // got a chance to run, not because unsubscribe failed.
    await waitFor(() => ws.outbox.some((m) => m.type === 'port-listen-snapshot'), 'initial port-listen-snapshot')
    await dispatch(broker, ws, { type: 'port-watch-unsubscribe' })
    const outboxLengthAfterUnsubscribe = ws.outbox.length
    await new Promise((r) => setTimeout(r, 50))
    expect(ws.outbox.length).toBe(outboxLengthAfterUnsubscribe)
    broker.close(ws)
  })
})

describe('createContainerBroker relay', () => {
  type FakeUpstream = {
    conn: UpstreamConnection
    handlers: UpstreamHandlers
    written: Uint8Array[]
    ended: boolean
  }

  let upstreams: Map<number, FakeUpstream>
  let openErrors: Map<number, string>

  const fakeConnect = async (port: number, handlers: UpstreamHandlers): Promise<UpstreamConnection> => {
    const err = openErrors.get(port)
    if (err) throw new Error(err)
    const written: Uint8Array[] = []
    let ended = false
    const conn: UpstreamConnection = {
      write: (chunk) => {
        written.push(chunk)
      },
      end: () => {
        ended = true
      },
    }
    upstreams.set(port, {
      conn,
      handlers,
      written,
      get ended() {
        return ended
      },
    } as FakeUpstream)
    return conn
  }

  beforeEach(() => {
    upstreams = new Map()
    openErrors = new Map()
  })

  afterEach(() => {
    upstreams.clear()
    openErrors.clear()
  })

  test('relay-open succeeds and acks', async () => {
    const broker = createContainerBroker({ expectedToken: 't', upstreamConnect: fakeConnect })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'relay-open', streamId: 1, port: 5173 })
    expect(ws.outbox.find((m) => m.type === 'relay-open-ack')).toEqual({ type: 'relay-open-ack', streamId: 1 })
    expect(upstreams.has(5173)).toBe(true)
  })

  test('relay-open failure sends nack with reason', async () => {
    openErrors.set(5173, 'ECONNREFUSED')
    const broker = createContainerBroker({ expectedToken: 't', upstreamConnect: fakeConnect })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'relay-open', streamId: 1, port: 5173 })
    expect(ws.outbox.find((m) => m.type === 'relay-open-nack')).toEqual({
      type: 'relay-open-nack',
      streamId: 1,
      reason: 'ECONNREFUSED',
    })
  })

  test('relay-data flows host→upstream after open', async () => {
    const broker = createContainerBroker({ expectedToken: 't', upstreamConnect: fakeConnect })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'relay-open', streamId: 1, port: 5173 })
    const payload = new TextEncoder().encode('GET / HTTP/1.1\r\n')
    await dispatch(broker, ws, { type: 'relay-data', streamId: 1, bytes: encodeBytes(payload) })
    const u = upstreams.get(5173)!
    expect(u.written).toHaveLength(1)
    expect(new TextDecoder().decode(u.written[0])).toBe('GET / HTTP/1.1\r\n')
  })

  test('upstream data emits relay-data downstream', async () => {
    const broker = createContainerBroker({ expectedToken: 't', upstreamConnect: fakeConnect })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'relay-open', streamId: 1, port: 5173 })
    const u = upstreams.get(5173)!
    u.handlers.onData(new TextEncoder().encode('HTTP/1.1 200 OK\r\n'))
    const ev = ws.outbox.find((m) => m.type === 'relay-data') as Extract<ContainerToHostd, { type: 'relay-data' }>
    expect(new TextDecoder().decode(decodeBytes(ev.bytes))).toBe('HTTP/1.1 200 OK\r\n')
  })

  test('relay-close from host ends the upstream connection', async () => {
    const broker = createContainerBroker({ expectedToken: 't', upstreamConnect: fakeConnect })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'relay-open', streamId: 1, port: 5173 })
    await dispatch(broker, ws, { type: 'relay-close', streamId: 1, side: 'downstream' })
    expect(upstreams.get(5173)!.ended).toBe(true)
  })

  test('upstream close emits relay-close upstream', async () => {
    const broker = createContainerBroker({ expectedToken: 't', upstreamConnect: fakeConnect })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'relay-open', streamId: 1, port: 5173 })
    upstreams.get(5173)!.handlers.onClose()
    expect(ws.outbox.find((m) => m.type === 'relay-close')).toEqual({
      type: 'relay-close',
      streamId: 1,
      side: 'upstream',
    })
  })

  test('close() ends all open upstreams', async () => {
    const broker = createContainerBroker({ expectedToken: 't', upstreamConnect: fakeConnect })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'relay-open', streamId: 1, port: 5173 })
    await dispatch(broker, ws, { type: 'relay-open', streamId: 2, port: 8080 })
    broker.close(ws)
    expect(upstreams.get(5173)!.ended).toBe(true)
    expect(upstreams.get(8080)!.ended).toBe(true)
  })
})

describe('createContainerBroker port-forward-result', () => {
  test('forwards ok results to onForwardResult subscriber', async () => {
    const events: Array<{ port: number; ok: boolean }> = []
    const broker = createContainerBroker({
      expectedToken: 't',
      onForwardResult: (e) => events.push({ port: e.port, ok: e.ok }),
    })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'port-forward-result', port: 4848, ok: true, hostPort: 4848 })

    expect(events).toEqual([{ port: 4848, ok: true }])
  })

  test('forwards failure results with reason', async () => {
    const events: Array<{ port: number; ok: boolean; reason?: string }> = []
    const broker = createContainerBroker({
      expectedToken: 't',
      onForwardResult: (e) =>
        events.push(e.ok ? { port: e.port, ok: true } : { port: e.port, ok: false, reason: e.reason }),
    })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await dispatch(broker, ws, { type: 'port-forward-result', port: 4848, ok: false, reason: 'EADDRINUSE' })

    expect(events).toEqual([{ port: 4848, ok: false, reason: 'EADDRINUSE' }])
  })

  test('does not call onForwardResult before broker-hello-ack', async () => {
    const events: unknown[] = []
    const broker = createContainerBroker({ expectedToken: 't', onForwardResult: (e) => events.push(e) })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'port-forward-result', port: 4848, ok: true, hostPort: 4848 })

    expect(events).toEqual([])
  })

  test('swallows subscriber errors so the broker keeps working', async () => {
    const broker = createContainerBroker({
      expectedToken: 't',
      onForwardResult: () => {
        throw new Error('boom')
      },
    })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })
    await expect(
      dispatch(broker, ws, { type: 'port-forward-result', port: 4848, ok: true, hostPort: 4848 }),
    ).resolves.toBeUndefined()
  })
})

describe('createContainerBroker port-forward-request', () => {
  test('published in-process request is sent after auth', async () => {
    const subscribers: Array<(event: ForwardRequestEvent) => void> = []
    const broker = createContainerBroker({
      expectedToken: 't',
      onForwardRequestSubscribe: (cb) => {
        subscribers.push(cb)
        return () => {}
      },
    })
    const ws = makeFakeSocket()
    broker.open(ws)
    await dispatch(broker, ws, { type: 'broker-hello', token: 't' })

    subscribers[0]?.({ targetPort: 4848, hostCandidates: [4848, 4849], reason: 'agent-browser-dashboard' })

    expect(ws.outbox).toContainEqual({
      type: 'port-forward-request',
      targetPort: 4848,
      hostCandidates: [4848, 4849],
      reason: 'agent-browser-dashboard',
    })
  })

  test('reconnect re-emits stored reserved request after broker-hello-ack', async () => {
    const subscribers: Array<(event: ForwardRequestEvent) => void> = []
    const broker = createContainerBroker({
      expectedToken: 't',
      onForwardRequestSubscribe: (cb) => {
        subscribers.push(cb)
        return () => {}
      },
    })
    const first = makeFakeSocket()
    broker.open(first)
    await dispatch(broker, first, { type: 'broker-hello', token: 't' })
    subscribers[0]?.({ targetPort: 4848, hostCandidates: [4848, 4849] })
    broker.close(first)

    const second = makeFakeSocket()
    broker.open(second)
    await dispatch(broker, second, { type: 'broker-hello', token: 't' })

    expect(second.outbox).toEqual([
      { type: 'broker-hello-ack' },
      { type: 'port-forward-request', targetPort: 4848, hostCandidates: [4848, 4849] },
    ])
  })

  test('does not emit request before broker-hello-ack', () => {
    const subscribers: Array<(event: ForwardRequestEvent) => void> = []
    const broker = createContainerBroker({
      expectedToken: 't',
      onForwardRequestSubscribe: (cb) => {
        subscribers.push(cb)
        return () => {}
      },
    })
    const ws = makeFakeSocket()
    broker.open(ws)

    subscribers[0]?.({ targetPort: 4848, hostCandidates: [4848] })

    expect(ws.outbox).toEqual([])
  })
})
