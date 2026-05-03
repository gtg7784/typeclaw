import type { Socket, TCPSocketListener } from 'bun'

import type { PortForward } from '@/config'

import { brokerEnabled, shouldForward } from './policy'
import type { BindAddr } from './proc-net-tcp'
import {
  decodeBytes,
  encodeBytes,
  type ContainerToHostd,
  type HostdToContainer,
  type PortForwardEvent,
  type StreamId,
} from './protocol'

export type BrokerOptions = {
  containerName: string
  cwd: string
  policy: PortForward
  // Resolves the host port currently published for this container's
  // CONTAINER_PORT mapping. The broker calls this on each (re)connect attempt
  // because the supervisor's restart can pick a different port if the previous
  // one is now bound. Returning null signals "container not running yet" — the
  // broker waits and retries.
  resolveHostPort: () => Promise<number | null>
  brokerToken: string
  onEvent: (event: PortForwardEvent) => void
  onLog?: (msg: string) => void
  connectWs?: (url: string) => Promise<WsClient>
  listenHost?: ListenHostFn
  reconnectDelaysMs?: number[]
  hostBindAddr?: string
}

export type WsClient = {
  send: (msg: HostdToContainer) => void
  close: () => void
  onMessage: (cb: (msg: ContainerToHostd) => void) => void
  onClose: (cb: () => void) => void
}

export type ListenHostFn = (
  host: string,
  port: number,
  handlers: {
    onConnection: (sock: HostSocket) => void
  },
) => Promise<HostListener>

export type HostListener = {
  port: number
  stop: () => void
}

export type HostSocket = {
  write: (chunk: Uint8Array) => void
  end: () => void
  onData: (cb: (chunk: Uint8Array) => void) => void
  onClose: (cb: () => void) => void
}

export type Broker = {
  start: () => void
  stop: () => Promise<void>
  forwardedPorts: () => number[]
}

const DEFAULT_RECONNECT_DELAYS = [1_000, 2_000, 4_000, 10_000]
const DEFAULT_HOST_BIND = '127.0.0.1'

export function createBroker(opts: BrokerOptions): Broker {
  const log = opts.onLog ?? (() => {})
  const reconnectDelays = opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS
  const hostBind = opts.hostBindAddr ?? DEFAULT_HOST_BIND
  const connectWs = opts.connectWs ?? defaultConnectWs
  const listenHost = opts.listenHost ?? defaultListenHost

  type ForwarderState = {
    port: number
    bindAddr: BindAddr
    listener: HostListener
    streams: Map<StreamId, { sock: HostSocket; opened: boolean; pending: Uint8Array[] }>
  }

  const forwarders = new Map<number, ForwarderState>()
  let ws: WsClient | null = null
  let nextStreamId: StreamId = 1
  let stopped = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const allocStreamId = (): StreamId => {
    const id = nextStreamId
    nextStreamId = nextStreamId >= 0x7fffffff ? 1 : nextStreamId + 1
    return id
  }

  const emit = (event: PortForwardEvent): void => {
    try {
      opts.onEvent(event)
    } catch (err) {
      log(`onEvent threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const closeStream = (port: number, streamId: StreamId, sendClose: boolean): void => {
    const fwd = forwarders.get(port)
    if (!fwd) return
    const stream = fwd.streams.get(streamId)
    if (!stream) return
    fwd.streams.delete(streamId)
    try {
      stream.sock.end()
    } catch {}
    if (sendClose && ws) ws.send({ type: 'relay-close', streamId, side: 'downstream' })
  }

  const handleHostConnection = (port: number, sock: HostSocket): void => {
    if (!ws) {
      try {
        sock.end()
      } catch {}
      return
    }
    const streamId = allocStreamId()
    const fwd = forwarders.get(port)
    if (!fwd) {
      try {
        sock.end()
      } catch {}
      return
    }
    fwd.streams.set(streamId, { sock, opened: false, pending: [] })

    sock.onData((chunk) => {
      const stream = fwd.streams.get(streamId)
      if (!stream) return
      const copy = new Uint8Array(chunk.byteLength)
      copy.set(chunk)
      if (stream.opened) {
        if (ws) ws.send({ type: 'relay-data', streamId, bytes: encodeBytes(copy) })
      } else {
        stream.pending.push(copy)
      }
    })
    sock.onClose(() => {
      closeStream(port, streamId, true)
    })

    if (ws) ws.send({ type: 'relay-open', streamId, port })
  }

  const installForwarder = async (port: number, bindAddr: BindAddr): Promise<void> => {
    if (forwarders.has(port)) return
    if (!shouldForward({ policy: opts.policy, port })) return
    try {
      const listener = await listenHost(hostBind, port, {
        onConnection: (sock) => handleHostConnection(port, sock),
      })
      forwarders.set(port, { port, bindAddr, listener, streams: new Map() })
      emit({ kind: 'port-forward-opened', containerName: opts.containerName, port, bindAddr })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log(`forward bind ${port}: ${reason}`)
      emit({ kind: 'port-forward-failed', containerName: opts.containerName, port, reason })
    }
  }

  const removeForwarder = (port: number, reason: 'container-released' | 'host-error'): void => {
    const fwd = forwarders.get(port)
    if (!fwd) return
    forwarders.delete(port)
    try {
      fwd.listener.stop()
    } catch {}
    for (const [streamId] of fwd.streams) closeStream(port, streamId, false)
    emit({ kind: 'port-forward-closed', containerName: opts.containerName, port, reason })
  }

  const teardownAllForwarders = (reason: 'broker-stopped' | 'deregistered' | 'host-error'): void => {
    for (const port of Array.from(forwarders.keys())) {
      const fwd = forwarders.get(port)
      if (!fwd) continue
      forwarders.delete(port)
      try {
        fwd.listener.stop()
      } catch {}
      for (const [streamId] of fwd.streams) {
        const stream = fwd.streams.get(streamId)
        try {
          stream?.sock.end()
        } catch {}
      }
      emit({ kind: 'port-forward-closed', containerName: opts.containerName, port, reason })
    }
  }

  const handleContainerMessage = (msg: ContainerToHostd): void => {
    switch (msg.type) {
      case 'broker-hello-ack':
        if (ws) ws.send({ type: 'port-watch-subscribe' })
        return
      case 'broker-hello-nack':
        log(`broker-hello rejected: ${msg.reason}`)
        if (ws) ws.close()
        return
      case 'port-listen-snapshot':
        for (const { port, bindAddr } of msg.ports) {
          void installForwarder(port, bindAddr)
        }
        return
      case 'port-listen-opened':
        void installForwarder(msg.port, msg.bindAddr)
        return
      case 'port-listen-closed':
        removeForwarder(msg.port, 'container-released')
        return
      case 'relay-open-ack': {
        const port = findStreamPort(msg.streamId)
        if (port === null) return
        const fwd = forwarders.get(port)!
        const stream = fwd.streams.get(msg.streamId)
        if (!stream) return
        stream.opened = true
        if (ws) {
          for (const buf of stream.pending)
            ws.send({ type: 'relay-data', streamId: msg.streamId, bytes: encodeBytes(buf) })
        }
        stream.pending = []
        return
      }
      case 'relay-open-nack': {
        const port = findStreamPort(msg.streamId)
        if (port !== null) closeStream(port, msg.streamId, false)
        return
      }
      case 'relay-data': {
        const port = findStreamPort(msg.streamId)
        if (port === null) return
        const stream = forwarders.get(port)?.streams.get(msg.streamId)
        if (!stream) return
        try {
          stream.sock.write(decodeBytes(msg.bytes))
        } catch {}
        return
      }
      case 'relay-close': {
        const port = findStreamPort(msg.streamId)
        if (port !== null) closeStream(port, msg.streamId, false)
        return
      }
    }
  }

  const findStreamPort = (streamId: StreamId): number | null => {
    for (const [port, fwd] of forwarders) {
      if (fwd.streams.has(streamId)) return port
    }
    return null
  }

  const connect = async (): Promise<void> => {
    if (stopped) return
    const hostPort = await opts.resolveHostPort()
    if (hostPort === null) {
      scheduleReconnect()
      return
    }
    const url = `ws://127.0.0.1:${hostPort}/portbroker`
    let client: WsClient
    try {
      client = await connectWs(url)
    } catch (err) {
      log(`ws connect ${url}: ${err instanceof Error ? err.message : String(err)}`)
      scheduleReconnect()
      return
    }
    ws = client
    reconnectAttempt = 0

    client.onMessage(handleContainerMessage)
    client.onClose(() => {
      ws = null
      teardownAllForwarders('host-error')
      scheduleReconnect()
    })

    client.send({ type: 'broker-hello', token: opts.brokerToken })
  }

  const scheduleReconnect = (): void => {
    if (stopped) return
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 10_000
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  return {
    start() {
      if (!brokerEnabled(opts.policy)) {
        log(`portForward disabled (allow:[]) — broker not started for ${opts.containerName}`)
        return
      }
      void connect()
    },
    async stop() {
      stopped = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      teardownAllForwarders('broker-stopped')
      if (ws) {
        try {
          ws.close()
        } catch {}
        ws = null
      }
    },
    forwardedPorts() {
      return Array.from(forwarders.keys())
    },
  }
}

async function defaultConnectWs(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let resolved = false
    const messageCbs: Array<(msg: ContainerToHostd) => void> = []
    const closeCbs: Array<() => void> = []
    const client: WsClient = {
      send: (msg) => {
        try {
          ws.send(JSON.stringify(msg))
        } catch {}
      },
      close: () => {
        try {
          ws.close()
        } catch {}
      },
      onMessage: (cb) => {
        messageCbs.push(cb)
      },
      onClose: (cb) => {
        closeCbs.push(cb)
      },
    }
    ws.onopen = (): void => {
      resolved = true
      resolve(client)
    }
    ws.onmessage = (ev: MessageEvent): void => {
      let msg: ContainerToHostd
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ContainerToHostd
      } catch {
        return
      }
      for (const cb of messageCbs) cb(msg)
    }
    ws.onerror = (): void => {
      if (!resolved) reject(new Error(`ws error connecting to ${url}`))
    }
    ws.onclose = (): void => {
      for (const cb of closeCbs) cb()
    }
  })
}

function defaultListenHost(
  host: string,
  port: number,
  handlers: { onConnection: (sock: HostSocket) => void },
): Promise<HostListener> {
  return new Promise((resolve, reject) => {
    type SocketState = { dataCbs: Array<(c: Uint8Array) => void>; closeCbs: Array<() => void> }
    let listener: TCPSocketListener<SocketState> | null = null
    try {
      listener = Bun.listen<SocketState>({
        hostname: host,
        port,
        socket: {
          open(s: Socket<SocketState>) {
            s.data = { dataCbs: [], closeCbs: [] }
            const sockApi: HostSocket = {
              write: (chunk) => {
                try {
                  s.write(chunk)
                } catch {}
              },
              end: () => {
                try {
                  s.end()
                } catch {}
              },
              onData: (cb) => {
                s.data.dataCbs.push(cb)
              },
              onClose: (cb) => {
                s.data.closeCbs.push(cb)
              },
            }
            handlers.onConnection(sockApi)
          },
          data(s: Socket<SocketState>, data: Buffer) {
            const copy = new Uint8Array(data.byteLength)
            copy.set(data)
            for (const cb of s.data.dataCbs) cb(copy)
          },
          close(s: Socket<SocketState>) {
            for (const cb of s.data.closeCbs) cb()
          },
          error() {},
        },
      })
      const captured = listener
      resolve({
        port: captured?.port ?? port,
        stop: () => {
          try {
            captured?.stop(true)
          } catch {}
        },
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
