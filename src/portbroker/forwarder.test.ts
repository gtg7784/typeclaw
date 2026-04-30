import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { Socket, TCPSocketListener } from 'bun'

import { startForwarder, type Forwarder } from './forwarder'

type EchoServer = {
  port: number
  stop: () => void
}

type EchoState = unknown

async function startEchoServer(): Promise<EchoServer> {
  let listener: TCPSocketListener<EchoState> | null = null
  listener = Bun.listen<EchoState>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {},
      data(socket: Socket<EchoState>, chunk: Buffer) {
        socket.write(chunk)
      },
      close() {},
    },
  })
  return {
    port: listener.port,
    stop: () => {
      listener?.stop(true)
    },
  }
}

async function pickFreePort(): Promise<number> {
  const placeholder = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { open() {}, data() {}, close() {} },
  })
  const port = placeholder.port
  placeholder.stop(true)
  return port
}

async function roundtripOverHostPort(hostPort: number, payload: string): Promise<string> {
  const received: Buffer[] = []
  let onData: (chunk: Buffer) => void = () => {}
  const dataPromise = new Promise<Buffer>((resolve) => {
    onData = (chunk) => {
      received.push(chunk)
      resolve(Buffer.concat(received))
    }
  })

  const client = await Bun.connect({
    hostname: '127.0.0.1',
    port: hostPort,
    socket: {
      open(s) {
        s.write(payload)
      },
      data(_s, chunk) {
        onData(chunk)
      },
      close() {},
      error() {},
    },
  })

  const result = await Promise.race([
    dataPromise,
    new Promise<Buffer>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
  ])
  client.end()
  return result.toString('utf8')
}

let echo: EchoServer
let forwarder: Forwarder | null = null

beforeEach(async () => {
  echo = await startEchoServer()
  forwarder = null
})

afterEach(async () => {
  if (forwarder) await forwarder.stop()
  echo.stop()
})

describe('startForwarder', () => {
  test('forwards bytes from host port to upstream and back', async () => {
    const hostPort = await pickFreePort()
    const result = await startForwarder({
      hostPort,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    forwarder = result.forwarder

    const echoed = await roundtripOverHostPort(hostPort, 'hello world')
    expect(echoed).toBe('hello world')
  })

  test('returns error result when host port is already in use', async () => {
    const hostPort = await pickFreePort()
    const occupier = Bun.listen({
      hostname: '127.0.0.1',
      port: hostPort,
      socket: { open() {}, data() {}, close() {} },
    })

    try {
      const result = await startForwarder({
        hostPort,
        upstreamHost: '127.0.0.1',
        upstreamPort: echo.port,
      })
      expect(result.ok).toBe(false)
    } finally {
      occupier.stop(true)
    }
  })

  test('releases host port on stop so another forwarder can claim it', async () => {
    const hostPort = await pickFreePort()
    const first = await startForwarder({
      hostPort,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await first.forwarder.stop()

    const second = await startForwarder({
      hostPort,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
    })
    expect(second.ok).toBe(true)
    if (second.ok) forwarder = second.forwarder
  })

  test('exposes the configured ports on the returned forwarder', async () => {
    const hostPort = await pickFreePort()
    const result = await startForwarder({
      hostPort,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    forwarder = result.forwarder
    expect(forwarder.hostPort).toBe(hostPort)
    expect(forwarder.upstreamHost).toBe('127.0.0.1')
    expect(forwarder.upstreamPort).toBe(echo.port)
  })
})
