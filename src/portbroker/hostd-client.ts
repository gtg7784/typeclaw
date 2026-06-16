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
  // A broker's token is immutable for its lifetime, so an auth rejection can
  // never be repaired by reconnecting. On auth nack the broker stops for good
  // and reports the reason so hostd can GC the stale registration.
  onFatalAuthFailure?: (reason: string) => void
  onLog?: (msg: string) => void
  connectWs?: (url: string, timeoutMs: number) => Promise<WsClient>
  connectTimeoutMs?: number
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
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

// broker-hello-nack reasons emitted by container-server.ts when authentication
// fails. These are immutable for a broker instance's lifetime, so reconnecting
// the same broker can only reproduce them — the broker must stop instead.
const AUTH_NACK_REASONS: ReadonlySet<string> = new Set(['invalid token', 'expected broker-hello first'])

export function createBroker(opts: BrokerOptions): Broker {
  const log = opts.onLog ?? (() => {})
  const reconnectDelays = opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS
  const hostBind = opts.hostBindAddr ?? DEFAULT_HOST_BIND
  const connectWs = opts.connectWs ?? defaultConnectWs
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const listenHost = opts.listenHost ?? defaultListenHost

  type ForwarderState = {
    targetPort: number
    hostPort: number
    bindAddr: BindAddr
    reserved: boolean
    listener: HostListener
    streams: Map<StreamId, { sock: HostSocket; opened: boolean; pending: Uint8Array[] }>
  }

  const forwarders = new Map<number, ForwarderState>()
  const reservedTargets = new Map<number, number>()
  // Targets claimed by a reserved forward whose host bind is still in flight.
  // Marked synchronously BEFORE awaiting listenHost() so a concurrent
  // port-listen snapshot/opened for the same target cannot slip past the
  // reserved guard and install a competing auto-forward during the await.
  const pendingReservedTargets = new Set<number>()
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

  const closeStream = (hostPort: number, streamId: StreamId, sendClose: boolean): void => {
    const fwd = forwarders.get(hostPort)
    if (!fwd) return
    const stream = fwd.streams.get(streamId)
    if (!stream) return
    fwd.streams.delete(streamId)
    try {
      stream.sock.end()
    } catch {}
    if (sendClose && ws) ws.send({ type: 'relay-close', streamId, side: 'downstream' })
  }

  const handleHostConnection = (hostPort: number, sock: HostSocket): void => {
    if (!ws) {
      try {
        sock.end()
      } catch {}
      return
    }
    const streamId = allocStreamId()
    const fwd = forwarders.get(hostPort)
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
      closeStream(hostPort, streamId, true)
    })

    if (ws) ws.send({ type: 'relay-open', streamId, port: fwd.targetPort })
  }

  const isReservedTarget = (targetPort: number): boolean =>
    reservedTargets.has(targetPort) || pendingReservedTargets.has(targetPort)

  const hasAutoForwarderForTarget = (targetPort: number): boolean => {
    for (const fwd of forwarders.values()) {
      if (!fwd.reserved && fwd.targetPort === targetPort) return true
    }
    return false
  }

  const installForwarder = async (targetPort: number, bindAddr: BindAddr): Promise<void> => {
    if (isReservedTarget(targetPort)) return
    // Dedup by targetPort, not the map key: the map is keyed by the bound host
    // port, which diverges from targetPort on an ephemeral bind, so a
    // `forwarders.has(targetPort)` guard would miss an existing forward and bind
    // a second host listener for the same container port.
    if (hasAutoForwarderForTarget(targetPort)) return
    if (!shouldForward({ policy: opts.policy, port: targetPort })) {
      // Policy excluded the port. Tell the container so consumers waiting on
      // port-forward-result can surface a diagnostic instead of hanging.
      if (ws) ws.send({ type: 'port-forward-result', port: targetPort, ok: false, reason: 'policy excluded' })
      return
    }
    try {
      // The host listen port — not targetPort — is the forwarders map key, so
      // the connection callback must look up by it. They coincide for ordinary
      // 1:1 auto-forwards but diverge whenever the OS reassigns the bind (e.g. a
      // port-0 ephemeral bind), at which point routing by targetPort misses the
      // map and silently drops the connection. Captured after the await; a
      // connection can only arrive once the listener is bound.
      let boundHostPort: number | undefined
      const listener = await listenHost(hostBind, targetPort, {
        onConnection: (sock) => {
          if (boundHostPort === undefined) {
            try {
              sock.end()
            } catch {}
            return
          }
          handleHostConnection(boundHostPort, sock)
        },
      })
      boundHostPort = listener.port
      forwarders.set(boundHostPort, {
        targetPort,
        hostPort: boundHostPort,
        bindAddr,
        reserved: false,
        listener,
        streams: new Map(),
      })
      emit({
        kind: 'port-forward-opened',
        containerName: opts.containerName,
        port: targetPort,
        hostPort: boundHostPort,
        bindAddr,
      })
      if (ws) ws.send({ type: 'port-forward-result', port: targetPort, ok: true, hostPort: boundHostPort })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log(`forward bind ${targetPort}: ${reason}`)
      emit({ kind: 'port-forward-failed', containerName: opts.containerName, port: targetPort, reason })
      if (ws) ws.send({ type: 'port-forward-result', port: targetPort, ok: false, reason })
    }
  }

  const installReservedForwarder = async (targetPort: number, hostCandidates: number[]): Promise<void> => {
    const existingHostPort = reservedTargets.get(targetPort)
    if (existingHostPort !== undefined) {
      if (ws) ws.send({ type: 'port-forward-result', port: targetPort, ok: true, hostPort: existingHostPort })
      return
    }
    if (!shouldForward({ policy: opts.policy, port: targetPort })) {
      if (ws) ws.send({ type: 'port-forward-result', port: targetPort, ok: false, reason: 'policy excluded' })
      return
    }

    // Claim the target and evict any auto-forward that already won the race
    // before the reserved bind below yields control to the event loop.
    pendingReservedTargets.add(targetPort)
    removeAutoForwarderForTarget(targetPort, 'container-released')

    let lastReason = 'no host candidates'
    for (const hostPort of hostCandidates) {
      try {
        // `port` stays the in-container target; the host listen port is the
        // forwarders map key the connection callback must route by. Reserved
        // forwards deliberately allow the two to differ, so route by the actual
        // bound port, captured after the await.
        let boundHostPort: number | undefined
        const listener = await listenHost(hostBind, hostPort, {
          onConnection: (sock) => {
            if (boundHostPort === undefined) {
              try {
                sock.end()
              } catch {}
              return
            }
            handleHostConnection(boundHostPort, sock)
          },
        })
        boundHostPort = listener.port
        forwarders.set(boundHostPort, {
          targetPort,
          hostPort: boundHostPort,
          bindAddr: '127.0.0.1',
          reserved: true,
          listener,
          streams: new Map(),
        })
        reservedTargets.set(targetPort, boundHostPort)
        pendingReservedTargets.delete(targetPort)
        emit({
          kind: 'port-forward-opened',
          containerName: opts.containerName,
          port: targetPort,
          hostPort: boundHostPort,
          bindAddr: '127.0.0.1',
        })
        if (ws) ws.send({ type: 'port-forward-result', port: targetPort, ok: true, hostPort: boundHostPort })
        return
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err)
        log(`reserved forward bind ${hostPort} for ${targetPort}: ${lastReason}`)
      }
    }
    pendingReservedTargets.delete(targetPort)
    emit({ kind: 'port-forward-failed', containerName: opts.containerName, port: targetPort, reason: lastReason })
    if (ws) ws.send({ type: 'port-forward-result', port: targetPort, ok: false, reason: lastReason })
  }

  const removeForwarder = (hostPort: number, reason: 'container-released' | 'host-error'): void => {
    const fwd = forwarders.get(hostPort)
    if (!fwd) return
    forwarders.delete(hostPort)
    if (fwd.reserved) reservedTargets.delete(fwd.targetPort)
    try {
      fwd.listener.stop()
    } catch {}
    for (const [streamId] of fwd.streams) closeStream(hostPort, streamId, false)
    emit({
      kind: 'port-forward-closed',
      containerName: opts.containerName,
      port: fwd.targetPort,
      hostPort: fwd.hostPort,
      reason,
    })
  }

  const removeAutoForwarderForTarget = (targetPort: number, reason: 'container-released' | 'host-error'): void => {
    for (const [hostPort, fwd] of Array.from(forwarders)) {
      if (!fwd.reserved && fwd.targetPort === targetPort) removeForwarder(hostPort, reason)
    }
  }

  const teardownAllForwarders = (reason: 'broker-stopped' | 'deregistered' | 'host-error'): void => {
    for (const hostPort of Array.from(forwarders.keys())) {
      const fwd = forwarders.get(hostPort)
      if (!fwd) continue
      forwarders.delete(hostPort)
      if (fwd.reserved) reservedTargets.delete(fwd.targetPort)
      try {
        fwd.listener.stop()
      } catch {}
      for (const [streamId] of fwd.streams) {
        const stream = fwd.streams.get(streamId)
        try {
          stream?.sock.end()
        } catch {}
      }
      emit({
        kind: 'port-forward-closed',
        containerName: opts.containerName,
        port: fwd.targetPort,
        hostPort: fwd.hostPort,
        reason,
      })
    }
  }

  const teardownAutoForwarders = (reason: 'host-error'): void => {
    for (const [hostPort, fwd] of Array.from(forwarders)) {
      if (!fwd.reserved) removeForwarder(hostPort, reason)
    }
  }

  const handleContainerMessage = (msg: ContainerToHostd): void => {
    switch (msg.type) {
      case 'broker-hello-ack':
        if (ws) ws.send({ type: 'port-watch-subscribe' })
        return
      case 'broker-hello-nack':
        log(`broker-hello rejected: ${msg.reason}`)
        if (AUTH_NACK_REASONS.has(msg.reason)) {
          fatalStop(msg.reason)
        } else if (ws) {
          ws.close()
        }
        return
      case 'port-listen-snapshot':
        for (const { port, bindAddr } of msg.ports) {
          if (!isReservedTarget(port)) void installForwarder(port, bindAddr)
        }
        return
      case 'port-listen-opened':
        if (isReservedTarget(msg.port)) return
        void installForwarder(msg.port, msg.bindAddr)
        return
      case 'port-listen-closed':
        if (isReservedTarget(msg.port)) return
        removeAutoForwarderForTarget(msg.port, 'container-released')
        return
      case 'port-forward-request':
        void installReservedForwarder(msg.targetPort, msg.hostCandidates)
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
      client = await connectWs(url, connectTimeoutMs)
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
      teardownAutoForwarders('host-error')
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

  const teardown = (): void => {
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
  }

  const fatalStop = (reason: string): void => {
    if (stopped) return
    teardown()
    opts.onFatalAuthFailure?.(reason)
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
      teardown()
    },
    forwardedPorts() {
      return Array.from(forwarders.keys())
    },
  }
}

async function defaultConnectWs(url: string, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let settled = false
    const messageCbs: Array<(msg: ContainerToHostd) => void> = []
    const closeCbs: Array<() => void> = []
    let connectTimeout: ReturnType<typeof setTimeout> | null = null
    const clearConnectTimeout = (): void => {
      if (connectTimeout !== null) {
        clearTimeout(connectTimeout)
        connectTimeout = null
      }
    }
    const failConnect = (err: Error): void => {
      if (settled) return
      settled = true
      clearConnectTimeout()
      reject(err)
    }
    connectTimeout = setTimeout(() => {
      failConnect(new Error(`ws connect timeout after ${timeoutMs}ms to ${url}`))
      try {
        ws.close()
      } catch {}
    }, timeoutMs)
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
      if (settled) return
      settled = true
      clearConnectTimeout()
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
      failConnect(new Error(`ws error connecting to ${url}`))
    }
    ws.onclose = (): void => {
      if (!settled) failConnect(new Error(`ws closed connecting to ${url}`))
      else clearConnectTimeout()
      for (const cb of closeCbs) cb()
    }
  })
}

export function defaultListenHost(
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
