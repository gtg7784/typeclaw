import { getBun } from '@/container/shared'

export type LoopbackProxyOptions = {
  containerName: string
  listenHost: string
  port: number
  pendingByteLimit?: number
  onExit?: (reason: string) => void
}

export type LoopbackProxy = {
  containerName: string
  listenHost: string
  port: number
  stop: () => Promise<void>
}

export type LoopbackProxyStartResult = { ok: true; proxy: LoopbackProxy } | { ok: false; reason: string }

export type LoopbackProxyFactory = (opts: LoopbackProxyOptions) => Promise<LoopbackProxyStartResult>

const PROXY_SCRIPT = String.raw`
const listenHost = process.argv[1]
const port = Number(process.argv[2])
const pendingByteLimit = Number(process.argv[3])
const upstreamHost = '127.0.0.1'

if (!listenHost || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(pendingByteLimit) || pendingByteLimit < 1) {
  console.error('invalid loopback proxy arguments')
  process.exit(1)
}

type Direction = {
  pending: Uint8Array[]
  pendingBytes: number
}

type ProxyState = {
  upstream: import('bun').Socket<ProxyState> | null
  client: import('bun').Socket<ProxyState>
  closed: boolean
  toUpstream: Direction
  toClient: Direction
}

function copy(chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk.byteLength)
  out.set(chunk)
  return out
}

function flush(direction: Direction, socket: import('bun').Socket<ProxyState>, state: ProxyState): void {
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

function enqueue(direction: Direction, socket: import('bun').Socket<ProxyState> | null, chunk: Uint8Array, state: ProxyState): void {
  direction.pending.push(copy(chunk))
  direction.pendingBytes += chunk.byteLength
  if (direction.pendingBytes > pendingByteLimit) {
    teardown(state)
    return
  }
  if (socket) flush(direction, socket, state)
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

Bun.listen<ProxyState>({
  hostname: listenHost,
  port,
  socket: {
    open(client) {
      const state: ProxyState = {
        upstream: null,
        client,
        closed: false,
        toUpstream: { pending: [], pendingBytes: 0 },
        toClient: { pending: [], pendingBytes: 0 },
      }
      client.data = state
      Bun.connect<ProxyState>({
        hostname: upstreamHost,
        port,
        socket: {
          open(upstream) {
            if (state.closed) {
              upstream.end()
              return
            }
            state.upstream = upstream
            upstream.data = state
            flush(state.toUpstream, upstream, state)
          },
          data(_upstream, chunk) {
            if (!state.closed) enqueue(state.toClient, state.client, chunk, state)
          },
          drain(upstream) {
            flush(state.toUpstream, upstream, state)
          },
          close() {
            teardown(state)
          },
          error() {
            teardown(state)
          },
        },
      }).catch(() => teardown(state))
    },
    data(client, chunk) {
      const state = client.data
      if (!state || state.closed) return
      enqueue(state.toUpstream, state.upstream, chunk, state)
    },
    drain(client) {
      const state = client.data
      if (!state || state.closed) return
      flush(state.toClient, state.client, state)
    },
    close(client) {
      const state = client.data
      if (state) teardown(state)
    },
    error(client) {
      const state = client.data
      if (state) teardown(state)
    },
  },
})

await new Promise(() => {})
`

export async function startLoopbackProxy(opts: LoopbackProxyOptions): Promise<LoopbackProxyStartResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const proc = bun.spawn({
    cmd: [
      'docker',
      'exec',
      opts.containerName,
      'bun',
      '-e',
      PROXY_SCRIPT,
      opts.listenHost,
      String(opts.port),
      String(opts.pendingByteLimit ?? 4 * 1024 * 1024),
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const earlyExit = await Promise.race([
    proc.exited.then(async (exitCode) => ({
      exitCode,
      stderr: await new Response(proc.stderr).text(),
    })),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
  ])
  if (earlyExit !== null) {
    return { ok: false, reason: earlyExit.stderr.trim() || `docker exec exited ${earlyExit.exitCode}` }
  }

  let stopped = false
  void proc.exited.then(async (exitCode) => {
    if (stopped) return
    const stderr = await new Response(proc.stderr).text().catch(() => '')
    opts.onExit?.(stderr.trim() || `docker exec exited ${exitCode}`)
  })

  const proxy: LoopbackProxy = {
    containerName: opts.containerName,
    listenHost: opts.listenHost,
    port: opts.port,
    stop: async () => {
      stopped = true
      proc.kill()
      await proc.exited.catch(() => {})
    },
  }
  return { ok: true, proxy }
}
