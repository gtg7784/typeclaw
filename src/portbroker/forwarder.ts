import type { Socket, TCPSocketListener } from 'bun'

export type ForwarderOptions = {
  hostPort: number
  upstreamHost: string
  upstreamPort: number
}

export type ForwarderStartResult = { ok: true; forwarder: Forwarder } | { ok: false; reason: string }

export type Forwarder = {
  hostPort: number
  upstreamHost: string
  upstreamPort: number
  stop: () => Promise<void>
}

type ProxyState = {
  upstream: Socket<ProxyState> | null
  pendingFromClient: Buffer[]
  client: Socket<ProxyState>
  closed: boolean
}

export async function startForwarder(opts: ForwarderOptions): Promise<ForwarderStartResult> {
  let listener: TCPSocketListener<ProxyState>
  try {
    listener = Bun.listen<ProxyState>({
      hostname: '127.0.0.1',
      port: opts.hostPort,
      socket: {
        open: (socket) => handleOpen(socket, opts),
        data: (socket, chunk) => handleData(socket, chunk),
        close: (socket) => handleClose(socket),
        error: (socket, err) => handleClose(socket, err),
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

function handleOpen(client: Socket<ProxyState>, opts: ForwarderOptions): void {
  const state: ProxyState = {
    upstream: null,
    pendingFromClient: [],
    client,
    closed: false,
  }
  client.data = state

  Bun.connect<ProxyState>({
    hostname: opts.upstreamHost,
    port: opts.upstreamPort,
    socket: {
      open: (upstream) => {
        if (state.closed) {
          upstream.end()
          return
        }
        state.upstream = upstream
        upstream.data = state
        for (const buf of state.pendingFromClient) upstream.write(buf)
        state.pendingFromClient = []
      },
      data: (_upstream, chunk) => {
        if (state.closed) return
        state.client.write(chunk)
      },
      close: () => {
        if (state.closed) return
        state.closed = true
        state.client.end()
      },
      error: () => {
        if (state.closed) return
        state.closed = true
        state.client.end()
      },
    },
  }).catch(() => {
    state.closed = true
    state.client.end()
  })
}

function handleData(client: Socket<ProxyState>, chunk: Buffer): void {
  const state = client.data
  if (state.closed) return
  if (state.upstream === null) {
    state.pendingFromClient.push(Buffer.from(chunk))
    return
  }
  state.upstream.write(chunk)
}

function handleClose(client: Socket<ProxyState>, _err?: unknown): void {
  const state = client.data
  if (!state || state.closed) return
  state.closed = true
  state.upstream?.end()
}
