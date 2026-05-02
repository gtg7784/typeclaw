import { existsSync } from 'node:fs'
import { chmod, unlink } from 'node:fs/promises'

import type { Socket, UnixSocketListener } from 'bun'

import type { PortForward } from '@/config'
import { defaultDockerExec, type DockerExec } from '@/container'
import type { PortForwardEvent } from '@/portbroker'

import { isDaemonReachable } from './client'
import { ensureDirs, socketPath } from './paths'
import type {
  HttpInfoResult,
  ListResult,
  Request,
  Response as RpcResponse,
  RestartResult,
  ShutdownResult,
  StatusResult,
  VersionResult,
} from './protocol'
import { buildSupervisor, type SupervisorLogEvent, type SupervisorRestart } from './supervisor'
import { UNVERSIONED_SENTINEL } from './version'

export type DaemonOptions = {
  exec?: DockerExec
  onLog?: (event: DaemonLogEvent | SupervisorLogEvent) => void
  gcIntervalMs?: number
  gcMissesToDeregister?: number
  socket?: string
  // When provided, the daemon honors `restart` RPCs by invoking this with the
  // (containerName, cwd) it captured at register time. Omit to disable the
  // capability in tests.
  restart?: SupervisorRestart
  // Source-tree fingerprint captured at daemon boot. Reported via the
  // `version` RPC so the CLI can detect when its on-disk source has drifted
  // from what the running daemon loaded, and trigger a respawn over the
  // `shutdown` RPC. Omit to advertise as unversioned (drift detection
  // disabled — both peers compare equal on the sentinel).
  version?: string
  // Invoked after the daemon finishes its self-initiated stop in response to
  // a `shutdown` RPC. Production wiring exits the process here so the host
  // can spawn a fresh daemon; tests omit it to keep the process alive.
  onShutdown?: () => void
  httpHost?: string
  httpPort?: number
  // Port-broker capability. When provided, register-RPC's portForward/wsHostPort
  // fields trigger broker spawn alongside supervisor registration. Tests omit
  // it to keep the broker out of unrelated suites.
  portbroker?: PortbrokerCallbacks
}

export type PortbrokerCallbacks = {
  start: (input: PortbrokerStartInput) => void
  stop: (containerName: string, reason: 'deregistered' | 'broker-stopped') => Promise<void>
}

export type PortbrokerStartInput = {
  containerName: string
  cwd: string
  policy: PortForward
  wsHostPort: number
  brokerToken: string
  onEvent: (event: PortForwardEvent) => void
}

export type DaemonLogEvent =
  | { kind: 'daemon-listening'; socket: string }
  | { kind: 'daemon-http-listening'; host: string; port: number }
  | { kind: 'daemon-stopping' }
  | { kind: 'register'; containerName: string }
  | { kind: 'deregister'; containerName: string; reason: 'requested' | 'gone' }
  | { kind: 'shutdown-requested' }
  | { kind: 'port-forward-event'; event: PortForwardEvent }

export type Daemon = {
  registered: () => string[]
  stop: () => Promise<void>
}

const DEFAULT_GC_INTERVAL_MS = 30_000
const DEFAULT_GC_MISSES_TO_DEREGISTER = 3
const MAX_REQUEST_BUFFER_BYTES = 64 * 1024
const MAX_HTTP_REQUEST_BYTES = 64 * 1024

type ServerState = { buf: string }

function json(response: RpcResponse, status = 200): globalThis.Response {
  return new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bearerToken(value: string | null): string | null {
  if (!value) return null
  const prefix = 'Bearer '
  if (!value.startsWith(prefix)) return null
  return value.slice(prefix.length)
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  await ensureDirs()
  const path = opts.socket ?? socketPath()

  if (existsSync(path)) {
    if (await isDaemonReachable(500)) {
      throw new Error(`another typeclaw host daemon is already listening at ${path}`)
    }
    try {
      await unlink(path)
    } catch {}
  }

  const log = opts.onLog ?? (() => {})
  const exec = opts.exec ?? defaultDockerExec
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS
  const gcMissesToDeregister = opts.gcMissesToDeregister ?? DEFAULT_GC_MISSES_TO_DEREGISTER
  const version = opts.version ?? UNVERSIONED_SENTINEL
  const cwds = new Map<string, string>()
  const restartTokens = new Map<string, string>()
  const perContainerSerial = new Map<string, Promise<unknown>>()
  const gcMisses = new Map<string, number>()
  let stopped = false
  let httpPort = 0

  const supervisor = opts.restart
    ? buildSupervisor({
        restart: opts.restart,
        onLog: (event) => log(event),
        isStopped: () => stopped,
      })
    : null

  // Per-container serialization: register/deregister chains through the same
  // promise per containerName, so a deregister arriving mid-register cannot
  // observe a partial state.
  const runSerially = <T>(name: string, op: () => Promise<T>): Promise<T> => {
    const prev = perContainerSerial.get(name) ?? Promise.resolve()
    const next = prev.then(op, op)
    perContainerSerial.set(
      name,
      next.catch(() => {}),
    )
    return next
  }

  const handleRegister = async (req: {
    containerName: string
    cwd: string
    restartToken?: string
    wsHostPort?: number
    portForward?: PortForward
    brokerToken?: string
  }): Promise<RpcResponse> => {
    if (stopped) return { ok: false, reason: 'daemon stopping' }
    return runSerially(req.containerName, async () => {
      if (stopped) return { ok: false, reason: 'daemon stopping' }
      const alreadyRegistered = cwds.has(req.containerName)
      cwds.set(req.containerName, req.cwd)
      if (req.restartToken) restartTokens.set(req.containerName, req.restartToken)
      else restartTokens.delete(req.containerName)
      if (!alreadyRegistered) {
        log({ kind: 'register', containerName: req.containerName })
      }
      if (
        opts.portbroker &&
        req.wsHostPort !== undefined &&
        req.portForward !== undefined &&
        req.brokerToken !== undefined
      ) {
        opts.portbroker.start({
          containerName: req.containerName,
          cwd: req.cwd,
          policy: req.portForward,
          wsHostPort: req.wsHostPort,
          brokerToken: req.brokerToken,
          onEvent: (event) => log({ kind: 'port-forward-event', event }),
        })
      }
      return { ok: true }
    })
  }

  const handleDeregister = async (req: { containerName: string }): Promise<RpcResponse> =>
    runSerially(req.containerName, async () => {
      const hadCwd = cwds.delete(req.containerName)
      restartTokens.delete(req.containerName)
      gcMisses.delete(req.containerName)
      if (opts.portbroker) await opts.portbroker.stop(req.containerName, 'deregistered').catch(() => {})
      if (hadCwd) log({ kind: 'deregister', containerName: req.containerName, reason: 'requested' })
      return { ok: true }
    })

  const handleList = (): RpcResponse => {
    const result: ListResult = {
      registrations: Array.from(cwds.entries()).map(([containerName, cwd]) => ({ containerName, cwd })),
    }
    return { ok: true, result }
  }

  const handleStatus = (req: { containerName: string }): RpcResponse => {
    const cwd = cwds.get(req.containerName)
    if (!cwd) return { ok: false, reason: `not registered: ${req.containerName}` }
    const result: StatusResult = {
      containerName: req.containerName,
      cwd,
    }
    return { ok: true, result }
  }

  // Auth: only restart containers that registered with this daemon. The
  // socket is 0o600 + UID-bound, but inside a container any process that
  // reaches the mounted socket could otherwise restart any peer container on
  // the host. Scoping by registered name limits the blast radius to the set
  // of containers this user already started.
  const handleRestart = (req: { containerName: string }): RpcResponse => {
    if (!supervisor) return { ok: false, reason: 'restart capability not enabled on this daemon' }
    const cwd = cwds.get(req.containerName)
    if (!cwd) return { ok: false, reason: `not registered: ${req.containerName}` }
    const ack = supervisor.scheduleRestart({ containerName: req.containerName, cwd })
    if (!ack.ok) return ack
    const result: RestartResult = { containerName: req.containerName, scheduled: true }
    return { ok: true, result }
  }

  const handleHttpInfo = (): RpcResponse => {
    const result: HttpInfoResult = { port: httpPort }
    return { ok: true, result }
  }

  const handleVersion = (): RpcResponse => {
    const result: VersionResult = { version }
    return { ok: true, result }
  }

  // Honors a `shutdown` RPC by ACKing first, then tearing the daemon down on
  // the next tick so the reply has time to drain over the socket. The CLI's
  // respawn flow polls the socket file's disappearance to know when it can
  // safely spawn a fresh daemon, which is why teardown must complete (and
  // unlink the socket) before exit. Why an RPC instead of the pidfile-based
  // SIGTERM the AGENTS.md "PID-reuse safety" rule warns about: the socket
  // round-trip itself proves we are talking to the daemon we just registered
  // with, so a stale pidfile cannot redirect the kill to an unrelated process.
  const handleShutdown = (): RpcResponse => {
    if (stopped) return { ok: true, result: { scheduled: true } satisfies ShutdownResult }
    log({ kind: 'shutdown-requested' })
    setTimeout(() => {
      void daemonHandle.stop().then(() => {
        if (opts.onShutdown) opts.onShutdown()
      })
    }, 0)
    return { ok: true, result: { scheduled: true } satisfies ShutdownResult }
  }

  const dispatch = async (req: Request): Promise<RpcResponse> => {
    switch (req.kind) {
      case 'register':
        return handleRegister(req)
      case 'deregister':
        return handleDeregister(req)
      case 'list':
        return handleList()
      case 'status':
        return handleStatus(req)
      case 'restart':
        return handleRestart(req)
      case 'http-info':
        return handleHttpInfo()
      case 'version':
        return handleVersion()
      case 'shutdown':
        return handleShutdown()
    }
  }

  const respond = (sock: Socket<ServerState>, response: RpcResponse): void => {
    try {
      sock.write(`${JSON.stringify(response)}\n`)
    } catch {}
    try {
      sock.end()
    } catch {}
  }

  const handleData = (sock: Socket<ServerState>, chunk: Buffer): void => {
    sock.data.buf += chunk.toString('utf8')
    if (sock.data.buf.length > MAX_REQUEST_BUFFER_BYTES) {
      respond(sock, { ok: false, reason: 'request exceeds buffer limit' })
      return
    }
    let newline = sock.data.buf.indexOf('\n')
    while (newline >= 0) {
      const line = sock.data.buf.slice(0, newline)
      sock.data.buf = sock.data.buf.slice(newline + 1)
      let req: Request
      try {
        req = JSON.parse(line) as Request
      } catch {
        respond(sock, { ok: false, reason: 'invalid request json' })
        return
      }
      void dispatch(req).then(
        (response) => respond(sock, response),
        (error) => respond(sock, { ok: false, reason: error instanceof Error ? error.message : String(error) }),
      )
      newline = sock.data.buf.indexOf('\n')
    }
  }

  const httpServer = Bun.serve({
    hostname: opts.httpHost ?? '0.0.0.0',
    port: opts.httpPort ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST' || url.pathname !== '/rpc') {
        return json({ ok: false, reason: 'not found' }, 404)
      }
      const token = bearerToken(req.headers.get('authorization'))
      if (!token) return json({ ok: false, reason: 'missing bearer token' }, 401)
      const contentLength = Number(req.headers.get('content-length') ?? '0')
      if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_REQUEST_BYTES) {
        return json({ ok: false, reason: 'request exceeds buffer limit' }, 413)
      }
      let rpc: Request
      try {
        const body = await req.text()
        if (body.length > MAX_HTTP_REQUEST_BYTES)
          return json({ ok: false, reason: 'request exceeds buffer limit' }, 413)
        rpc = JSON.parse(body) as Request
      } catch {
        return json({ ok: false, reason: 'invalid request json' }, 400)
      }
      if (rpc.kind !== 'restart') {
        return json({ ok: false, reason: 'http transport only supports restart' }, 403)
      }
      if (restartTokens.get(rpc.containerName) !== token) {
        return json({ ok: false, reason: 'invalid restart token' }, 403)
      }
      return json(handleRestart(rpc))
    },
  })
  httpPort = httpServer.port ?? 0
  log({ kind: 'daemon-http-listening', host: opts.httpHost ?? '0.0.0.0', port: httpPort })

  const listener: UnixSocketListener<ServerState> = Bun.listen<ServerState>({
    unix: path,
    socket: {
      open: (sock) => {
        sock.data = { buf: '' }
      },
      data: handleData,
      close: () => {},
      error: () => {},
    },
  })
  // Restrict socket to the owning user; ~/.typeclaw/run is also 0700.
  await chmod(path, 0o600).catch(() => {})
  log({ kind: 'daemon-listening', socket: path })

  // GC tick distinguishes "container confirmed gone" from "docker call failed":
  // a `docker ps` blip should not deregister a live container registration, so
  // we require gcMissesToDeregister consecutive confirmed absences.
  const probeContainerAlive = async (name: string): Promise<'alive' | 'gone' | 'unknown'> => {
    try {
      const result = await exec(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])
      if (result.exitCode !== 0) return 'unknown'
      const names = result.stdout
        .trim()
        .split('\n')
        .filter((s) => s.length > 0)
      return names.includes(name) ? 'alive' : 'gone'
    } catch {
      return 'unknown'
    }
  }

  const runGc = async (): Promise<void> => {
    for (const name of Array.from(cwds.keys())) {
      const status = await probeContainerAlive(name)
      if (status === 'alive') {
        gcMisses.delete(name)
        continue
      }
      if (status === 'unknown') continue
      const misses = (gcMisses.get(name) ?? 0) + 1
      if (misses < gcMissesToDeregister) {
        gcMisses.set(name, misses)
        continue
      }
      gcMisses.delete(name)
      void runSerially(name, async () => {
        const hadCwd = cwds.delete(name)
        if (opts.portbroker) await opts.portbroker.stop(name, 'deregistered').catch(() => {})
        if (hadCwd) log({ kind: 'deregister', containerName: name, reason: 'gone' })
        return { ok: true }
      })
    }
  }

  const gcTimer = setInterval(() => {
    if (stopped || cwds.size === 0) return
    void runGc()
  }, gcIntervalMs)

  const daemonHandle: Daemon = {
    registered: () => Array.from(cwds.keys()),
    stop: async () => {
      if (stopped) return
      stopped = true
      log({ kind: 'daemon-stopping' })
      clearInterval(gcTimer)
      try {
        listener.stop(true)
      } catch {}
      httpServer.stop(true)
      if (opts.portbroker) {
        const names = Array.from(cwds.keys())
        await Promise.allSettled(names.map((n) => opts.portbroker!.stop(n, 'broker-stopped')))
      }
      cwds.clear()
      restartTokens.clear()
      try {
        if (existsSync(path)) await unlink(path)
      } catch {}
    },
  }
  return daemonHandle
}
