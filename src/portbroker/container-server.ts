import { readFile } from 'node:fs/promises'

import type { ServerWebSocket } from 'bun'

import type { ForwardRequestEvent } from './forward-request-bus'
import { parseProcNetTcp } from './proc-net-tcp'
import { decodeBytes, encodeBytes, type ContainerToHostd, type HostdToContainer, type StreamId } from './protocol'

export type BrokerWsData = { kind: 'portbroker'; authed: boolean }

export type ContainerBrokerOptions = {
  expectedToken: string
  pollIntervalMs?: number
  // Test seam: defaults to reading /proc/net/tcp + /proc/net/tcp6. Tests inject
  // a fake. The function MUST resolve with the *concatenated* contents of both
  // files (or just one if the system is IPv4-only) — the parser handles a
  // mixed input gracefully.
  readProcNetTcp?: () => Promise<string>
  // Test seam: replaces Bun.connect for unit tests.
  upstreamConnect?: (port: number, handlers: UpstreamHandlers) => Promise<UpstreamConnection>
  onLog?: (event: ContainerBrokerLogEvent) => void
  // In-container consumers (e.g. the agent-browser plugin) call this to learn
  // whether a port that just opened a LISTEN socket got successfully forwarded
  // to the host side. Without it, code that picks an in-container port has no
  // way to detect host-side EADDRINUSE collisions across containers.
  onForwardResult?: (event: ForwardResultEvent) => void
  onForwardRequestSubscribe?: (cb: (event: ForwardRequestEvent) => void) => () => void
}

export type ForwardResultEvent =
  | { port: number; ok: true; hostPort: number }
  | { port: number; ok: false; reason: string }

export type UpstreamHandlers = {
  onData: (chunk: Uint8Array) => void
  onClose: () => void
  onError: (err: Error) => void
}

export type UpstreamConnection = {
  write: (chunk: Uint8Array) => void
  end: () => void
}

export type ContainerBrokerLogEvent =
  | { kind: 'auth-failed'; reason: string }
  | { kind: 'authed' }
  | { kind: 'subscribed' }
  | { kind: 'unsubscribed' }
  | { kind: 'relay-open-failed'; streamId: StreamId; port: number; reason: string }
  | { kind: 'relay-data-error'; streamId: StreamId; reason: string }
  | { kind: 'unexpected'; reason: string }

export type ContainerBroker = {
  open: (ws: BrokerSocket) => void
  message: (ws: BrokerSocket, raw: string | Buffer) => Promise<void>
  close: (ws: BrokerSocket) => void
}

export type BrokerSocket = ServerWebSocket<BrokerWsData>

const DEFAULT_POLL_MS = 500

export function createContainerBroker(opts: ContainerBrokerOptions): ContainerBroker {
  const log = opts.onLog ?? (() => {})
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const readProc = opts.readProcNetTcp ?? defaultReadProcNetTcp
  const connectUpstream = opts.upstreamConnect ?? defaultUpstreamConnect

  type SessionState = {
    pollTimer: ReturnType<typeof setInterval> | null
    lastSnapshot: Map<number, '0.0.0.0' | '127.0.0.1'>
    upstreams: Map<StreamId, UpstreamConnection>
  }

  const sessions = new WeakMap<BrokerSocket, SessionState>()
  const sockets = new Set<BrokerSocket>()
  const reserved = new Map<number, ForwardRequestEvent>()

  const send = (ws: BrokerSocket, msg: ContainerToHostd): void => {
    try {
      ws.send(JSON.stringify(msg))
    } catch {}
  }

  const startWatcher = async (ws: BrokerSocket, state: SessionState): Promise<void> => {
    const initial = await snapshotPorts()
    state.lastSnapshot = initial
    send(ws, {
      type: 'port-listen-snapshot',
      ports: Array.from(initial.entries()).map(([port, bindAddr]) => ({ port, bindAddr })),
    })
    state.pollTimer = setInterval(() => {
      void tickWatcher(ws, state).catch(() => {})
    }, pollMs)
  }

  const stopWatcher = (state: SessionState): void => {
    if (state.pollTimer !== null) {
      clearInterval(state.pollTimer)
      state.pollTimer = null
    }
  }

  const sendReservedRequest = (ws: BrokerSocket, request: ForwardRequestEvent): void => {
    send(ws, {
      type: 'port-forward-request',
      targetPort: request.targetPort,
      hostCandidates: request.hostCandidates,
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    })
  }

  opts.onForwardRequestSubscribe?.((event) => {
    reserved.set(event.targetPort, event)
    for (const ws of sockets) {
      if (ws.data.authed) sendReservedRequest(ws, event)
    }
  })

  const tickWatcher = async (ws: BrokerSocket, state: SessionState): Promise<void> => {
    const next = await snapshotPorts()
    for (const [port, bindAddr] of next) {
      if (!state.lastSnapshot.has(port)) {
        send(ws, { type: 'port-listen-opened', port, bindAddr })
      }
    }
    for (const port of state.lastSnapshot.keys()) {
      if (!next.has(port)) {
        send(ws, { type: 'port-listen-closed', port })
      }
    }
    state.lastSnapshot = next
  }

  const snapshotPorts = async (): Promise<Map<number, '0.0.0.0' | '127.0.0.1'>> => {
    let raw: string
    try {
      raw = await readProc()
    } catch {
      return new Map()
    }
    const entries = parseProcNetTcp(raw)
    const m = new Map<number, '0.0.0.0' | '127.0.0.1'>()
    for (const e of entries) m.set(e.port, e.bindAddr)
    return m
  }

  const handleRelayOpen = async (ws: BrokerSocket, state: SessionState, msg: HostdToContainer): Promise<void> => {
    if (msg.type !== 'relay-open') return
    const { streamId, port } = msg
    try {
      const conn = await connectUpstream(port, {
        onData: (chunk) => {
          send(ws, { type: 'relay-data', streamId, bytes: encodeBytes(chunk) })
        },
        onClose: () => {
          if (state.upstreams.delete(streamId)) {
            send(ws, { type: 'relay-close', streamId, side: 'upstream' })
          }
        },
        onError: (err) => {
          if (state.upstreams.delete(streamId)) {
            log({ kind: 'relay-data-error', streamId, reason: err.message })
            send(ws, { type: 'relay-close', streamId, side: 'upstream' })
          }
        },
      })
      state.upstreams.set(streamId, conn)
      send(ws, { type: 'relay-open-ack', streamId })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log({ kind: 'relay-open-failed', streamId, port, reason })
      send(ws, { type: 'relay-open-nack', streamId, reason })
    }
  }

  return {
    open(ws) {
      sessions.set(ws, { pollTimer: null, lastSnapshot: new Map(), upstreams: new Map() })
      sockets.add(ws)
    },

    async message(ws, raw) {
      const state = sessions.get(ws)
      if (!state) return
      let msg: HostdToContainer
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as HostdToContainer
      } catch {
        log({ kind: 'unexpected', reason: 'invalid json' })
        return
      }

      if (!ws.data.authed) {
        if (msg.type !== 'broker-hello') {
          log({ kind: 'auth-failed', reason: 'first message was not broker-hello' })
          send(ws, { type: 'broker-hello-nack', reason: 'expected broker-hello first' })
          ws.close(1008, 'auth required')
          return
        }
        if (msg.token !== opts.expectedToken) {
          log({ kind: 'auth-failed', reason: 'token mismatch' })
          send(ws, { type: 'broker-hello-nack', reason: 'invalid token' })
          ws.close(1008, 'invalid token')
          return
        }
        ws.data.authed = true
        log({ kind: 'authed' })
        send(ws, { type: 'broker-hello-ack' })
        for (const request of reserved.values()) sendReservedRequest(ws, request)
        return
      }

      switch (msg.type) {
        case 'broker-hello':
          return
        case 'port-watch-subscribe':
          if (state.pollTimer === null) {
            log({ kind: 'subscribed' })
            await startWatcher(ws, state)
          }
          return
        case 'port-watch-unsubscribe':
          if (state.pollTimer !== null) {
            log({ kind: 'unsubscribed' })
            stopWatcher(state)
          }
          return
        case 'port-forward-result':
          if (opts.onForwardResult) {
            try {
              opts.onForwardResult(
                msg.ok
                  ? { port: msg.port, ok: true, hostPort: msg.hostPort }
                  : { port: msg.port, ok: false, reason: msg.reason },
              )
            } catch (err) {
              log({
                kind: 'unexpected',
                reason: `onForwardResult threw: ${err instanceof Error ? err.message : String(err)}`,
              })
            }
          }
          return
        case 'relay-open':
          await handleRelayOpen(ws, state, msg)
          return
        case 'relay-data': {
          const conn = state.upstreams.get(msg.streamId)
          if (conn) conn.write(decodeBytes(msg.bytes))
          return
        }
        case 'relay-close': {
          const conn = state.upstreams.get(msg.streamId)
          if (conn) {
            state.upstreams.delete(msg.streamId)
            try {
              conn.end()
            } catch {}
          }
          return
        }
      }
    },

    close(ws) {
      const state = sessions.get(ws)
      if (!state) return
      stopWatcher(state)
      for (const conn of state.upstreams.values()) {
        try {
          conn.end()
        } catch {}
      }
      state.upstreams.clear()
      sockets.delete(ws)
      sessions.delete(ws)
    },
  }
}

async function defaultReadProcNetTcp(): Promise<string> {
  const tcp4 = await readFile('/proc/net/tcp', 'utf8').catch(() => '')
  const tcp6 = await readFile('/proc/net/tcp6', 'utf8').catch(() => '')
  return `${tcp4}\n${tcp6}`
}

function defaultUpstreamConnect(port: number, handlers: UpstreamHandlers): Promise<UpstreamConnection> {
  return new Promise((resolve, reject) => {
    let resolved = false
    const sock = Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(s) {
          resolved = true
          resolve({
            write: (chunk: Uint8Array) => {
              try {
                s.write(chunk)
              } catch {}
            },
            end: () => {
              try {
                s.end()
              } catch {}
            },
          })
        },
        data(_s, data) {
          handlers.onData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice())
        },
        close() {
          handlers.onClose()
        },
        error(_s, error) {
          if (!resolved) {
            reject(error instanceof Error ? error : new Error(String(error)))
          } else {
            handlers.onError(error instanceof Error ? error : new Error(String(error)))
          }
        },
      },
    })
    void sock
  })
}
