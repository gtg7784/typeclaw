import type { Socket, TCPSocketListener } from 'bun'

export type ForwarderOptions = {
  hostPort: number
  upstreamHost: string
  upstreamPort: number
  pendingByteLimit?: number
  upstreamConnectTimeoutMs?: number
}

export type ForwarderStartResult = { ok: true; forwarder: Forwarder } | { ok: false; reason: string }

export type Forwarder = {
  hostPort: number
  upstreamHost: string
  upstreamPort: number
  stop: () => Promise<void>
}

const DEFAULT_PENDING_BYTE_LIMIT = 4 * 1024 * 1024
const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 5_000

type Direction = {
  pending: Uint8Array[]
  pendingBytes: number
}

type ProxyState = {
  upstream: Socket<ProxyState> | null
  client: Socket<ProxyState>
  closed: boolean
  toUpstream: Direction
  toClient: Direction
  pendingByteLimit: number
}

export async function startForwarder(opts: ForwarderOptions): Promise<ForwarderStartResult> {
  let listener: TCPSocketListener<ProxyState>
  try {
    listener = Bun.listen<ProxyState>({
      hostname: '127.0.0.1',
      port: opts.hostPort,
      socket: {
        open: (socket) => onClientOpen(socket, opts),
        data: (socket, chunk) => onClientData(socket, chunk),
        drain: (socket) => onClientDrain(socket),
        close: (socket) => onClientClose(socket),
        error: (socket) => onClientClose(socket),
      },
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  const forwarder: Forwarder = {
    hostPort: opts.hostPort,
    upstreamHost: opts.upstreamHost,
    upstreamPort: opts.upstreamPort,
    stop: async () => {
      listener.stop(true)
    },
  }
  return { ok: true, forwarder }
}

function onClientOpen(client: Socket<ProxyState>, opts: ForwarderOptions): void {
  const state: ProxyState = {
    upstream: null,
    client,
    closed: false,
    toUpstream: { pending: [], pendingBytes: 0 },
    toClient: { pending: [], pendingBytes: 0 },
    pendingByteLimit: opts.pendingByteLimit ?? DEFAULT_PENDING_BYTE_LIMIT,
  }
  client.data = state

  const connectTimeout = setTimeout(() => {
    if (state.upstream === null && !state.closed) {
      teardown(state)
    }
  }, opts.upstreamConnectTimeoutMs ?? DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS)

  Bun.connect<ProxyState>({
    hostname: opts.upstreamHost,
    port: opts.upstreamPort,
    socket: {
      open: (upstream) => {
        clearTimeout(connectTimeout)
        if (state.closed) {
          upstream.end()
          return
        }
        state.upstream = upstream
        upstream.data = state
        flush(state.toUpstream, upstream, state)
      },
      data: (_upstream, chunk) => {
        if (state.closed) return
        enqueueAndWrite(state.toClient, state.client, chunk, state)
      },
      drain: (upstream) => {
        flush(state.toUpstream, upstream, state)
      },
      close: () => {
        clearTimeout(connectTimeout)
        teardown(state)
      },
      error: () => {
        clearTimeout(connectTimeout)
        teardown(state)
      },
    },
  }).catch(() => {
    clearTimeout(connectTimeout)
    teardown(state)
  })
}

function onClientData(client: Socket<ProxyState>, chunk: Buffer): void {
  const state = client.data
  if (!state || state.closed) return
  if (state.upstream === null) {
    enqueueOnly(state.toUpstream, chunk, state)
    return
  }
  enqueueAndWrite(state.toUpstream, state.upstream, chunk, state)
}

function onClientDrain(client: Socket<ProxyState>): void {
  const state = client.data
  if (!state || state.closed) return
  flush(state.toClient, state.client, state)
}

function onClientClose(client: Socket<ProxyState>): void {
  const state = client.data
  if (!state) return
  teardown(state)
}

function enqueueOnly(direction: Direction, chunk: Uint8Array, state: ProxyState): void {
  // Bun reuses the buffer underlying `data` callbacks across calls, so we MUST
  // copy bytes before queueing or the queued reference will be silently
  // overwritten. Allocating a fresh Uint8Array forces the copy.
  const copy = new Uint8Array(chunk.byteLength)
  copy.set(chunk)
  direction.pending.push(copy)
  direction.pendingBytes += chunk.byteLength
  if (direction.pendingBytes > state.pendingByteLimit) teardown(state)
}

function enqueueAndWrite(direction: Direction, socket: Socket<ProxyState>, chunk: Uint8Array, state: ProxyState): void {
  if (direction.pending.length > 0) {
    enqueueOnly(direction, chunk, state)
    flush(direction, socket, state)
    return
  }
  const written = socket.write(chunk)
  if (written < 0) {
    teardown(state)
    return
  }
  if (written < chunk.byteLength) {
    enqueueOnly(direction, chunk.subarray(written), state)
  }
}

function flush(direction: Direction, socket: Socket<ProxyState>, state: ProxyState): void {
  while (direction.pending.length > 0) {
    const head = direction.pending[0]
    if (!head) {
      direction.pending.shift()
      continue
    }
    const written = socket.write(head)
    if (written < 0) {
      teardown(state)
      return
    }
    if (written === 0) return
    if (written < head.byteLength) {
      direction.pending[0] = head.subarray(written)
      direction.pendingBytes -= written
      return
    }
    direction.pending.shift()
    direction.pendingBytes -= head.byteLength
  }
}

function teardown(state: ProxyState): void {
  if (state.closed) return
  state.closed = true
  state.toUpstream.pending.length = 0
  state.toUpstream.pendingBytes = 0
  state.toClient.pending.length = 0
  state.toClient.pendingBytes = 0
  state.client.end()
  state.upstream?.end()
}
