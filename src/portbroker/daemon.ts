import { existsSync } from 'node:fs'
import { chmod, unlink } from 'node:fs/promises'

import type { Socket, UnixSocketListener } from 'bun'

import { defaultDockerExec, type DockerExec } from '@/container'

import {
  startBroker,
  type Broker,
  type BrokerLogEvent,
  type ContainerIpResolver,
  type ForwarderFactory,
} from './broker'
import { isDaemonReachable } from './client'
import { ensureDirs, socketPath } from './paths'
import type { ListResult, Request, Response, StatusResult } from './protocol'

export type DaemonOptions = {
  exec?: DockerExec
  resolveIp?: ContainerIpResolver
  forwarderFactory?: ForwarderFactory
  onLog?: (event: BrokerLogEvent | DaemonLogEvent) => void
  gcIntervalMs?: number
  gcMissesToDeregister?: number
  socket?: string
}

export type DaemonLogEvent =
  | { kind: 'daemon-listening'; socket: string }
  | { kind: 'daemon-stopping' }
  | { kind: 'register'; containerName: string }
  | { kind: 'deregister'; containerName: string; reason: 'requested' | 'gone' | 'fatal' }

export type Daemon = {
  registered: () => string[]
  stop: () => Promise<void>
}

const DEFAULT_GC_INTERVAL_MS = 30_000
const DEFAULT_GC_MISSES_TO_DEREGISTER = 3
const MAX_REQUEST_BUFFER_BYTES = 64 * 1024

type ServerState = { buf: string }

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  await ensureDirs()
  const path = opts.socket ?? socketPath()

  if (existsSync(path)) {
    if (await isDaemonReachable(500)) {
      throw new Error(`another portbroker daemon is already listening at ${path}`)
    }
    try {
      await unlink(path)
    } catch {}
  }

  const log = opts.onLog ?? (() => {})
  const exec = opts.exec ?? defaultDockerExec
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS
  const gcMissesToDeregister = opts.gcMissesToDeregister ?? DEFAULT_GC_MISSES_TO_DEREGISTER
  const brokers = new Map<string, Broker>()
  const perContainerSerial = new Map<string, Promise<unknown>>()
  const gcMisses = new Map<string, number>()
  let stopped = false

  // Per-container serialization: register/deregister/fatal-deregister chain
  // through the same promise per containerName, so a deregister arriving
  // mid-register cannot observe a partial state.
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
    excludePorts?: number[]
  }): Promise<Response> => {
    if (stopped) return { ok: false, reason: 'daemon stopping' }
    return runSerially(req.containerName, async () => {
      if (stopped) return { ok: false, reason: 'daemon stopping' }
      if (brokers.has(req.containerName)) return { ok: true }
      const result = await startBroker({
        containerName: req.containerName,
        excludePorts: new Set<number>(req.excludePorts ?? []),
        exec,
        resolveIp: opts.resolveIp,
        forwarderFactory: opts.forwarderFactory,
        onLog: (event) => log(event),
        onFatal: () => {
          void runSerially(req.containerName, async () => {
            const broker = brokers.get(req.containerName)
            if (!broker) return { ok: true }
            brokers.delete(req.containerName)
            log({ kind: 'deregister', containerName: req.containerName, reason: 'fatal' })
            await broker.stop()
            return { ok: true }
          })
        },
      })
      if (!result.ok) return { ok: false, reason: result.reason }
      brokers.set(req.containerName, result.broker)
      log({ kind: 'register', containerName: req.containerName })
      return { ok: true }
    })
  }

  const handleDeregister = async (req: { containerName: string }): Promise<Response> =>
    runSerially(req.containerName, async () => {
      const broker = brokers.get(req.containerName)
      if (!broker) return { ok: true }
      brokers.delete(req.containerName)
      gcMisses.delete(req.containerName)
      log({ kind: 'deregister', containerName: req.containerName, reason: 'requested' })
      await broker.stop()
      return { ok: true }
    })

  const handleList = (): Response => {
    const result: ListResult = {
      brokers: Array.from(brokers.values()).map((b) => ({
        containerName: b.containerName,
        forwardedPorts: b.forwardedPorts(),
        containerIp: b.containerIp(),
      })),
    }
    return { ok: true, result }
  }

  const handleStatus = (req: { containerName: string }): Response => {
    const broker = brokers.get(req.containerName)
    if (!broker) return { ok: false, reason: `not registered: ${req.containerName}` }
    const result: StatusResult = {
      containerName: broker.containerName,
      containerIp: broker.containerIp(),
      forwardedPorts: broker.forwardedPorts(),
    }
    return { ok: true, result }
  }

  const dispatch = async (req: Request): Promise<Response> => {
    switch (req.kind) {
      case 'register':
        return handleRegister(req)
      case 'deregister':
        return handleDeregister(req)
      case 'list':
        return handleList()
      case 'status':
        return handleStatus(req)
    }
  }

  const respond = (sock: Socket<ServerState>, response: Response): void => {
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
  // a `docker ps` blip should not deregister a live broker, so we require
  // gcMissesToDeregister consecutive confirmed-absences before tearing down.
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
    for (const name of Array.from(brokers.keys())) {
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
        const broker = brokers.get(name)
        if (!broker) return { ok: true }
        brokers.delete(name)
        log({ kind: 'deregister', containerName: name, reason: 'gone' })
        await broker.stop()
        return { ok: true }
      })
    }
  }

  const gcTimer = setInterval(() => {
    if (stopped || brokers.size === 0) return
    void runGc()
  }, gcIntervalMs)

  return {
    registered: () => Array.from(brokers.keys()),
    stop: async () => {
      if (stopped) return
      stopped = true
      log({ kind: 'daemon-stopping' })
      clearInterval(gcTimer)
      try {
        listener.stop(true)
      } catch {}
      const all = Array.from(brokers.values())
      brokers.clear()
      await Promise.all(all.map((b) => b.stop()))
      try {
        if (existsSync(path)) await unlink(path)
      } catch {}
    },
  }
}
