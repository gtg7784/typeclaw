import { describe, expect, test } from 'bun:test'

import type { PortForward } from '@/config'
import { expectStable, waitFor } from '@/test-helpers/wait-for'

import { createBroker, type HostListener, type HostSocket, type ListenHostFn, type WsClient } from './hostd-client'
import {
  decodeBytes,
  encodeBytes,
  type ContainerToHostd,
  type HostdToContainer,
  type PortForwardEvent,
} from './protocol'

type FakeWs = WsClient & {
  outbox: HostdToContainer[]
  emit: (msg: ContainerToHostd) => void
  triggerClose: () => void
  closed: boolean
}

function makeFakeWs(): FakeWs {
  const outbox: HostdToContainer[] = []
  let messageCb: ((m: ContainerToHostd) => void) | null = null
  let closeCb: (() => void) | null = null
  let closed = false
  const ws: FakeWs = {
    send: (msg) => {
      outbox.push(msg)
    },
    close: () => {
      closed = true
      if (closeCb) closeCb()
    },
    onMessage: (cb) => {
      messageCb = cb
    },
    onClose: (cb) => {
      closeCb = cb
    },
    outbox,
    emit: (msg) => {
      if (messageCb) messageCb(msg)
    },
    triggerClose: () => {
      if (closeCb) closeCb()
    },
    get closed() {
      return closed
    },
  } as FakeWs
  return ws
}

type FakeListener = HostListener & {
  sockets: FakeHostSocket[]
  stopped: boolean
  bound: { host: string; port: number }
}
type FakeHostSocket = HostSocket & {
  written: Uint8Array[]
  ended: boolean
  triggerData: (chunk: Uint8Array) => void
  triggerClose: () => void
}

function makeFakeHostSocket(): FakeHostSocket {
  const written: Uint8Array[] = []
  let ended = false
  let dataCb: ((c: Uint8Array) => void) | null = null
  let closeCb: (() => void) | null = null
  const sock: FakeHostSocket = {
    write: (chunk) => {
      written.push(chunk)
    },
    end: () => {
      ended = true
    },
    onData: (cb) => {
      dataCb = cb
    },
    onClose: (cb) => {
      closeCb = cb
    },
    written,
    get ended() {
      return ended
    },
    triggerData: (chunk) => {
      if (dataCb) dataCb(chunk)
    },
    triggerClose: () => {
      if (closeCb) closeCb()
    },
  } as FakeHostSocket
  return sock
}

function makeFakeListenHost(opts: {
  failPorts?: Set<number>
  listeners: Map<number, FakeListener>
  calls?: Array<{ host: string; port: number }>
}): ListenHostFn {
  return async (host, port, handlers) => {
    opts.calls?.push({ host, port })
    if (opts.failPorts?.has(port)) throw new Error('EADDRINUSE')
    const sockets: FakeHostSocket[] = []
    const listener: FakeListener = {
      port,
      stopped: false,
      bound: { host, port },
      sockets,
      stop: () => {
        listener.stopped = true
      },
    }
    opts.listeners.set(port, listener)
    ;(listener as unknown as { _accept: (s: FakeHostSocket) => void })._accept = (s) => {
      sockets.push(s)
      handlers.onConnection(s)
    }
    return listener
  }
}

function setup(opts: {
  policy: PortForward
  resolveHostPort?: () => Promise<number | null>
  failPorts?: Set<number>
  connectWs?: () => Promise<WsClient>
}) {
  const ws = makeFakeWs()
  const listeners = new Map<number, FakeListener>()
  const listenCalls: Array<{ host: string; port: number }> = []
  const events: PortForwardEvent[] = []
  const fatalAuthFailures: string[] = []
  const broker = createBroker({
    containerName: 'test-agent',
    cwd: '/tmp/test',
    policy: opts.policy,
    resolveHostPort: opts.resolveHostPort ?? (async () => 12345),
    brokerToken: 'tok',
    onEvent: (e) => events.push(e),
    onFatalAuthFailure: (reason) => fatalAuthFailures.push(reason),
    connectWs: opts.connectWs ?? (async () => ws),
    listenHost: makeFakeListenHost({
      ...(opts.failPorts ? { failPorts: opts.failPorts } : {}),
      listeners,
      calls: listenCalls,
    }),
    reconnectDelaysMs: [10, 10],
  })
  return { broker, ws, listeners, listenCalls, events, fatalAuthFailures }
}

describe('createBroker', () => {
  test('start sends broker-hello with token', async () => {
    const { broker, ws } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox[0])
    expect(ws.outbox[0]).toEqual({ type: 'broker-hello', token: 'tok' })
    await broker.stop()
  })

  test('on hello-ack, sends port-watch-subscribe', async () => {
    const { broker, ws } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    expect(ws.outbox).toContainEqual({ type: 'port-watch-subscribe' })
    await broker.stop()
  })

  test('auth nack (invalid token) is fatal: no reconnect, fires onFatalAuthFailure', async () => {
    const { broker, ws, fatalAuthFailures } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    const helloCount = () => ws.outbox.filter((m) => m.type === 'broker-hello').length
    expect(helloCount()).toBe(1)

    ws.emit({ type: 'broker-hello-nack', reason: 'invalid token' })

    await waitFor(() => fatalAuthFailures.length > 0)
    expect(fatalAuthFailures).toEqual(['invalid token'])
    expect(ws.closed).toBe(true)
    await expectStable(() => helloCount() > 1, { durationMs: 60, description: 'reconnect-after-auth-nack' })
    expect(helloCount()).toBe(1)
    await broker.stop()
  })

  test('non-auth WS close still reconnects', async () => {
    const { broker, ws, fatalAuthFailures } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))

    ws.triggerClose()

    await waitFor(() => ws.outbox.filter((m) => m.type === 'broker-hello').length >= 2)
    expect(fatalAuthFailures).toEqual([])
    await broker.stop()
  })

  test('snapshot installs forwarders for allowed ports and emits opened events', async () => {
    const { broker, ws, listeners, events } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({
      type: 'port-listen-snapshot',
      ports: [
        { port: 5173, bindAddr: '127.0.0.1' },
        { port: 8080, bindAddr: '0.0.0.0' },
      ],
    })
    await waitFor(() => listeners.has(5173) && listeners.has(8080))
    expect(
      events
        .filter((e) => e.kind === 'port-forward-opened')
        .map((e) => e.port)
        .sort(),
    ).toEqual([5173, 8080])
    await broker.stop()
  })

  test('deny list excludes ports from snapshot', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: '*', deny: [9229] } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({
      type: 'port-listen-snapshot',
      ports: [
        { port: 5173, bindAddr: '127.0.0.1' },
        { port: 9229, bindAddr: '127.0.0.1' },
      ],
    })
    await waitFor(() => listeners.has(5173))
    expect(listeners.has(9229)).toBe(false)
    await broker.stop()
  })

  test('allowlist excludes everything not listed', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: [5173] } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({
      type: 'port-listen-snapshot',
      ports: [
        { port: 5173, bindAddr: '127.0.0.1' },
        { port: 8080, bindAddr: '127.0.0.1' },
      ],
    })
    await waitFor(() => listeners.has(5173))
    expect(listeners.has(8080)).toBe(false)
    await broker.stop()
  })

  test('off-switch (allow:[]) skips broker entirely', async () => {
    const { broker, ws } = setup({ policy: { allow: [] } })
    broker.start()
    await expectStable(() => ws.outbox.length > 0, { durationMs: 10, description: 'broker outbox' })
    expect(ws.outbox).toEqual([])
    await broker.stop()
  })

  test('port-listen-opened mid-stream installs new forwarder', async () => {
    const { broker, ws, listeners, events } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [] })
    ws.emit({ type: 'port-listen-opened', port: 5173, bindAddr: '127.0.0.1' })
    await waitFor(() => listeners.has(5173))
    expect(events.find((e) => e.kind === 'port-forward-opened' && e.port === 5173)).toBeDefined()
    await broker.stop()
  })

  test('port-listen-closed tears down forwarder and emits closed event', async () => {
    const { broker, ws, listeners, events } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [{ port: 5173, bindAddr: '127.0.0.1' }] })
    await waitFor(() => listeners.has(5173))
    ws.emit({ type: 'port-listen-closed', port: 5173 })
    expect(listeners.get(5173)?.stopped).toBe(true)
    expect(events.find((e) => e.kind === 'port-forward-closed' && e.port === 5173)).toMatchObject({
      reason: 'container-released',
    })
    await broker.stop()
  })

  test('EADDRINUSE on bind emits port-forward-failed and does not retry', async () => {
    const { broker, ws, events } = setup({ policy: { allow: '*' }, failPorts: new Set([5173]) })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [{ port: 5173, bindAddr: '127.0.0.1' }] })
    await waitFor(() => events.find((e) => e.kind === 'port-forward-failed' && e.port === 5173))
    expect(events.find((e) => e.kind === 'port-forward-failed' && e.port === 5173)).toMatchObject({
      reason: 'EADDRINUSE',
    })
    await broker.stop()
  })

  test('host connection allocates streamId and sends relay-open', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [{ port: 5173, bindAddr: '127.0.0.1' }] })
    await waitFor(() => listeners.has(5173))
    const sock = makeFakeHostSocket()
    ;(listeners.get(5173) as unknown as { _accept: (s: HostSocket) => void })._accept(sock)
    const open = ws.outbox.find((m) => m.type === 'relay-open') as Extract<HostdToContainer, { type: 'relay-open' }>
    expect(open).toBeDefined()
    expect(open.port).toBe(5173)
    await broker.stop()
  })

  test('relay-data flows host→container after open-ack', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [{ port: 5173, bindAddr: '127.0.0.1' }] })
    await waitFor(() => listeners.has(5173))
    const sock = makeFakeHostSocket()
    ;(listeners.get(5173) as unknown as { _accept: (s: HostSocket) => void })._accept(sock)
    const open = ws.outbox.find((m) => m.type === 'relay-open') as Extract<HostdToContainer, { type: 'relay-open' }>
    sock.triggerData(new TextEncoder().encode('hello'))
    ws.emit({ type: 'relay-open-ack', streamId: open.streamId })
    const data = ws.outbox.find((m) => m.type === 'relay-data') as Extract<HostdToContainer, { type: 'relay-data' }>
    expect(data).toBeDefined()
    expect(new TextDecoder().decode(decodeBytes(data.bytes))).toBe('hello')
    await broker.stop()
  })

  test('container relay-data writes to host socket', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [{ port: 5173, bindAddr: '127.0.0.1' }] })
    await waitFor(() => listeners.has(5173))
    const sock = makeFakeHostSocket()
    ;(listeners.get(5173) as unknown as { _accept: (s: HostSocket) => void })._accept(sock)
    const open = ws.outbox.find((m) => m.type === 'relay-open') as Extract<HostdToContainer, { type: 'relay-open' }>
    ws.emit({ type: 'relay-open-ack', streamId: open.streamId })
    ws.emit({ type: 'relay-data', streamId: open.streamId, bytes: encodeBytes(new TextEncoder().encode('world')) })
    expect(sock.written).toHaveLength(1)
    expect(new TextDecoder().decode(sock.written[0])).toBe('world')
    await broker.stop()
  })

  test('relay-open-nack closes the host socket', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [{ port: 5173, bindAddr: '127.0.0.1' }] })
    await waitFor(() => listeners.has(5173))
    const sock = makeFakeHostSocket()
    ;(listeners.get(5173) as unknown as { _accept: (s: HostSocket) => void })._accept(sock)
    const open = ws.outbox.find((m) => m.type === 'relay-open') as Extract<HostdToContainer, { type: 'relay-open' }>
    ws.emit({ type: 'relay-open-nack', streamId: open.streamId, reason: 'ECONNREFUSED' })
    expect(sock.ended).toBe(true)
    await broker.stop()
  })

  test('host socket close sends relay-close', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [{ port: 5173, bindAddr: '127.0.0.1' }] })
    await waitFor(() => listeners.has(5173))
    const sock = makeFakeHostSocket()
    ;(listeners.get(5173) as unknown as { _accept: (s: HostSocket) => void })._accept(sock)
    const open = ws.outbox.find((m) => m.type === 'relay-open') as Extract<HostdToContainer, { type: 'relay-open' }>
    ws.emit({ type: 'relay-open-ack', streamId: open.streamId })
    sock.triggerClose()
    const close = ws.outbox.find((m) => m.type === 'relay-close') as Extract<HostdToContainer, { type: 'relay-close' }>
    expect(close).toEqual({ type: 'relay-close', streamId: open.streamId, side: 'downstream' })
    await broker.stop()
  })

  test('ws disconnect tears down all forwarders and emits closed events', async () => {
    const { broker, ws, listeners, events } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({
      type: 'port-listen-snapshot',
      ports: [
        { port: 5173, bindAddr: '127.0.0.1' },
        { port: 8080, bindAddr: '0.0.0.0' },
      ],
    })
    await waitFor(() => listeners.has(5173) && listeners.has(8080))
    ws.triggerClose()
    expect(listeners.get(5173)?.stopped).toBe(true)
    expect(listeners.get(8080)?.stopped).toBe(true)
    expect(events.filter((e) => e.kind === 'port-forward-closed' && e.reason === 'host-error').length).toBe(2)
    await broker.stop()
  })

  test('stop() ends all forwarders and emits broker-stopped events', async () => {
    const { broker, ws, listeners, events } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-snapshot', ports: [{ port: 5173, bindAddr: '127.0.0.1' }] })
    await waitFor(() => listeners.has(5173))
    await broker.stop()
    expect(listeners.get(5173)?.stopped).toBe(true)
    expect(events.find((e) => e.kind === 'port-forward-closed' && e.reason === 'broker-stopped')).toBeDefined()
  })

  test('forwardedPorts() reflects currently bound ports', async () => {
    const { broker, ws } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({
      type: 'port-listen-snapshot',
      ports: [
        { port: 5173, bindAddr: '127.0.0.1' },
        { port: 8080, bindAddr: '0.0.0.0' },
      ],
    })
    await waitFor(() => broker.forwardedPorts().length === 2)
    expect(broker.forwardedPorts().sort()).toEqual([5173, 8080])
    await broker.stop()
  })

  test('resolveHostPort returning null defers connect (waits for retry)', async () => {
    let calls = 0
    const { broker, ws } = setup({
      policy: { allow: '*' },
      resolveHostPort: async () => {
        calls += 1
        return calls < 3 ? null : 12345
      },
    })
    broker.start()
    await waitFor(() => ws.outbox.find((m) => m.type === 'broker-hello'))
    expect(calls).toBeGreaterThanOrEqual(3)
    await broker.stop()
  })

  test('emits port-forward-result back to container after successful forward', async () => {
    const { broker, ws } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-opened', port: 4848, bindAddr: '127.0.0.1' })
    const result = await waitFor(() => ws.outbox.find((m) => m.type === 'port-forward-result'))
    expect(result).toEqual({ type: 'port-forward-result', port: 4848, ok: true, hostPort: 4848 })
    await broker.stop()
  })

  test('emits port-forward-result with failure when host bind fails', async () => {
    const { broker, ws } = setup({ policy: { allow: '*' }, failPorts: new Set([4848]) })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-opened', port: 4848, bindAddr: '127.0.0.1' })
    const result = await waitFor(() => ws.outbox.find((m) => m.type === 'port-forward-result'))
    expect(result).toMatchObject({ type: 'port-forward-result', port: 4848, ok: false })
    if (result?.type === 'port-forward-result' && !result.ok) {
      expect(result.reason.length).toBeGreaterThan(0)
    }
    await broker.stop()
  })

  test('emits port-forward-result with policy-excluded reason for denied ports', async () => {
    const { broker, ws } = setup({ policy: { allow: [5173] } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-listen-opened', port: 4848, bindAddr: '127.0.0.1' })
    const result = await waitFor(() => ws.outbox.find((m) => m.type === 'port-forward-result'))
    expect(result).toEqual({ type: 'port-forward-result', port: 4848, ok: false, reason: 'policy excluded' })
    await broker.stop()
  })

  test('reserved request binds the first free host candidate and targets the requested container port', async () => {
    const { broker, ws, listeners, events } = setup({ policy: { allow: '*' }, failPorts: new Set([4848]) })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-forward-request', targetPort: 4848, hostCandidates: [4848, 4849] })

    const result = await waitFor(() => ws.outbox.find((m) => m.type === 'port-forward-result'))
    expect(result).toEqual({ type: 'port-forward-result', port: 4848, ok: true, hostPort: 4849 })
    expect(listeners.has(4849)).toBe(true)
    expect(events.find((e) => e.kind === 'port-forward-opened')).toMatchObject({ port: 4848, hostPort: 4849 })

    const sock = makeFakeHostSocket()
    ;(listeners.get(4849) as unknown as { _accept: (s: HostSocket) => void })._accept(sock)
    const open = ws.outbox.find((m) => m.type === 'relay-open') as Extract<HostdToContainer, { type: 'relay-open' }>
    expect(open.port).toBe(4848)
    await broker.stop()
  })

  test('reserved request reports failure when all host candidates are busy', async () => {
    const { broker, ws } = setup({ policy: { allow: '*' }, failPorts: new Set([4848, 4849]) })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-forward-request', targetPort: 4848, hostCandidates: [4848, 4849] })

    const result = await waitFor(() => ws.outbox.find((m) => m.type === 'port-forward-result'))
    expect(result).toEqual({ type: 'port-forward-result', port: 4848, ok: false, reason: 'EADDRINUSE' })
    await broker.stop()
  })

  test('reserved forward suppresses auto-watcher double bind for the same target port', async () => {
    const { broker, ws, listenCalls } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-forward-request', targetPort: 4848, hostCandidates: [4848] })
    await waitFor(() => ws.outbox.find((m) => m.type === 'port-forward-result'))

    ws.emit({ type: 'port-listen-opened', port: 4848, bindAddr: '127.0.0.1' })
    await expectStable(() => listenCalls.filter((call) => call.port === 4848).length > 1, {
      durationMs: 30,
      description: 'duplicate reserved target bind',
    })
    expect(listenCalls.filter((call) => call.port === 4848)).toHaveLength(1)
    await broker.stop()
  })

  test('port-listen-closed for a reserved target does not remove the reserved listener', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-forward-request', targetPort: 4848, hostCandidates: [4848] })
    await waitFor(() => listeners.has(4848))

    ws.emit({ type: 'port-listen-closed', port: 4848 })

    expect(listeners.get(4848)?.stopped).toBe(false)
    await broker.stop()
  })

  test('relay-open nack closes only that host socket while the reserved listener stays bound', async () => {
    const { broker, ws, listeners } = setup({ policy: { allow: '*' } })
    broker.start()
    await waitFor(() => ws.outbox.some((m) => m.type === 'broker-hello'))
    ws.emit({ type: 'broker-hello-ack' })
    ws.emit({ type: 'port-forward-request', targetPort: 4848, hostCandidates: [4848] })
    await waitFor(() => listeners.has(4848))

    const sock = makeFakeHostSocket()
    ;(listeners.get(4848) as unknown as { _accept: (s: HostSocket) => void })._accept(sock)
    const open = ws.outbox.find((m) => m.type === 'relay-open') as Extract<HostdToContainer, { type: 'relay-open' }>
    ws.emit({ type: 'relay-open-nack', streamId: open.streamId, reason: 'ECONNREFUSED' })

    expect(sock.ended).toBe(true)
    expect(listeners.get(4848)?.stopped).toBe(false)
    await broker.stop()
  })
})
