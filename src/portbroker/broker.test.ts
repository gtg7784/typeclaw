import { afterEach, describe, expect, test } from 'bun:test'

import { expectStable, waitFor } from '@/test-helpers/wait-for'

import {
  createContainerBroker,
  type ContainerBroker,
  type UpstreamConnection,
  type UpstreamHandlers,
} from './container-server'
import { createBroker, type Broker } from './hostd-client'
import type { PortForwardEvent } from './protocol'

type Harness = {
  containerServer: ReturnType<typeof Bun.serve>
  broker: Broker
  events: PortForwardEvent[]
  upstreams: Map<number, FakeUpstream>
  cleanup: () => Promise<void>
}

type FakeUpstream = {
  conn: UpstreamConnection
  handlers: UpstreamHandlers
  written: Uint8Array[]
}

async function startHarness(opts: {
  procSnapshots: string[]
  policy: Parameters<typeof createBroker>[0]['policy']
  failPorts?: Set<number>
}): Promise<Harness> {
  const upstreams = new Map<number, FakeUpstream>()
  let snapshotCursor = 0
  const readProc = async (): Promise<string> => {
    const out = opts.procSnapshots[snapshotCursor] ?? opts.procSnapshots[opts.procSnapshots.length - 1] ?? ''
    snapshotCursor = Math.min(snapshotCursor + 1, opts.procSnapshots.length - 1)
    return out
  }

  const fakeUpstreamConnect = async (port: number, handlers: UpstreamHandlers): Promise<UpstreamConnection> => {
    const written: Uint8Array[] = []
    const conn: UpstreamConnection = {
      write: (chunk) => {
        written.push(chunk)
      },
      end: () => {
        handlers.onClose()
      },
    }
    upstreams.set(port, { conn, handlers, written })
    return conn
  }

  const containerBroker: ContainerBroker = createContainerBroker({
    expectedToken: 'shared-token',
    pollIntervalMs: 10,
    readProcNetTcp: readProc,
    upstreamConnect: fakeUpstreamConnect,
  })

  type WsData = { kind: 'portbroker'; authed: boolean }

  const containerServer = Bun.serve<WsData>({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname !== '/portbroker') return new Response('not found', { status: 404 })
      if (server.upgrade(req, { data: { kind: 'portbroker', authed: false } })) return
      return new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      open(ws) {
        containerBroker.open(ws)
      },
      async message(ws, raw) {
        await containerBroker.message(ws, raw as string | Buffer)
      },
      close(ws) {
        containerBroker.close(ws)
      },
    },
  })

  const events: PortForwardEvent[] = []
  const broker = createBroker({
    containerName: 'test',
    cwd: '/tmp/test',
    policy: opts.policy,
    resolveHostPort: async () => containerServer.port ?? null,
    brokerToken: 'shared-token',
    onEvent: (e) => events.push(e),
    reconnectDelaysMs: [10, 10],
  })

  return {
    containerServer,
    broker,
    events,
    upstreams,
    cleanup: async () => {
      await broker.stop()
      containerServer.stop(true)
    },
  }
}

const procWith5173Loopback = `   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
const procEmpty = ``

describe('end-to-end portbroker pipeline', () => {
  let harness: Harness | null = null

  afterEach(async () => {
    if (harness) {
      await harness.cleanup()
      harness = null
    }
  })

  test('full handshake → snapshot → forwarder bound → host connection → bytes flow → close', async () => {
    harness = await startHarness({ procSnapshots: [procWith5173Loopback], policy: { allow: '*' } })
    harness.broker.start()
    await waitFor(() => harness!.events.find((e) => e.kind === 'port-forward-opened' && e.port === 5173))

    const opened = harness.events.find((e) => e.kind === 'port-forward-opened' && e.port === 5173)
    expect(opened).toBeDefined()

    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port: 5173,
      socket: {
        open(s) {
          s.write(new TextEncoder().encode('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))
        },
        data() {},
        close() {},
        error() {},
      },
    })
    await waitFor(() => {
      const u = harness!.upstreams.get(5173)
      return u && u.written.length > 0
    })
    sock.end()

    const upstream = harness.upstreams.get(5173)
    expect(upstream).toBeDefined()
    expect(upstream!.written.length).toBeGreaterThan(0)
    expect(new TextDecoder().decode(upstream!.written[0])).toContain('GET / HTTP/1.1')
  })

  test('container releases port → forwarder torn down', async () => {
    harness = await startHarness({
      procSnapshots: [procWith5173Loopback, procEmpty],
      policy: { allow: '*' },
    })
    harness.broker.start()
    await waitFor(() => harness!.events.some((e) => e.kind === 'port-forward-closed' && e.port === 5173))

    const closedEvents = harness.events.filter((e) => e.kind === 'port-forward-closed' && e.port === 5173)
    expect(closedEvents.length).toBeGreaterThanOrEqual(1)
    expect(closedEvents[0]).toMatchObject({ reason: 'container-released' })
    expect(harness.broker.forwardedPorts()).not.toContain(5173)
  })

  test('disabled by allow:[] — no events, no broker connect', async () => {
    harness = await startHarness({ procSnapshots: [procWith5173Loopback], policy: { allow: [] } })
    harness.broker.start()
    await expectStable(() => harness!.events.length > 0, { durationMs: 30, description: 'disabled-broker activity' })
    expect(harness.events).toEqual([])
    expect(harness.broker.forwardedPorts()).toEqual([])
  })

  test('deny:[port] excludes from snapshot end-to-end', async () => {
    const procWithBoth = `   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1
   1: 0100007F:240D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    harness = await startHarness({
      procSnapshots: [procWithBoth],
      policy: { allow: '*', deny: [9229] },
    })
    harness.broker.start()
    await waitFor(() => harness!.broker.forwardedPorts().length > 0)

    expect(harness.broker.forwardedPorts()).toEqual([5173])
  })

  test('bytes flow downstream — container-side data reaches host client', async () => {
    harness = await startHarness({ procSnapshots: [procWith5173Loopback], policy: { allow: '*' } })
    harness.broker.start()
    await waitFor(() => harness!.broker.forwardedPorts().includes(5173))

    const received: Uint8Array[] = []
    let sockHandle: Awaited<ReturnType<typeof Bun.connect>> | null = null
    sockHandle = await Bun.connect({
      hostname: '127.0.0.1',
      port: 5173,
      socket: {
        open(s) {
          s.write(new TextEncoder().encode('hi'))
        },
        data(_s, data) {
          received.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice())
        },
        close() {},
        error() {},
      },
    })
    const upstream = await waitFor(() => harness!.upstreams.get(5173))
    expect(upstream).toBeDefined()
    upstream.handlers.onData(new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n'))
    await waitFor(() => received.length > 0)

    expect(received.length).toBeGreaterThan(0)
    const text = received.map((b) => new TextDecoder().decode(b)).join('')
    expect(text).toContain('HTTP/1.1 200 OK')

    sockHandle.end()
  })
})
