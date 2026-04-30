import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'

import type { Socket, UnixSocketListener } from 'bun'

import { defaultDockerExec, containerExists, type DockerExec } from '@/container'

import {
  startBroker,
  type Broker,
  type BrokerLogEvent,
  type ContainerIpResolver,
  type ForwarderFactory,
} from './broker'
import { ensureDirs, socketPath } from './paths'
import type { ListResult, Request, Response, StatusResult } from './protocol'

export type DaemonOptions = {
  exec?: DockerExec
  resolveIp?: ContainerIpResolver
  forwarderFactory?: ForwarderFactory
  onLog?: (event: BrokerLogEvent | DaemonLogEvent) => void
  gcIntervalMs?: number
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

type ServerState = { buf: string }

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  await ensureDirs()
  const path = opts.socket ?? socketPath()
  if (existsSync(path)) {
    try {
      await unlink(path)
    } catch {}
  }

  const log = opts.onLog ?? (() => {})
  const exec = opts.exec ?? defaultDockerExec
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS
  const brokers = new Map<string, Broker>()
  const inflightRegistrations = new Map<string, Promise<Response>>()
  let stopped = false

  const handleRegister = async (req: { containerName: string; cwd: string }): Promise<Response> => {
    if (stopped) return { ok: false, reason: 'daemon stopping' }
    if (brokers.has(req.containerName)) return { ok: true }
    const inflight = inflightRegistrations.get(req.containerName)
    if (inflight) return inflight

    const promise = (async (): Promise<Response> => {
      const result = await startBroker({
        containerName: req.containerName,
        excludePorts: new Set<number>(),
        exec,
        resolveIp: opts.resolveIp,
        forwarderFactory: opts.forwarderFactory,
        onLog: (event) => log(event),
        onFatal: () => {
          const broker = brokers.get(req.containerName)
          if (!broker) return
          brokers.delete(req.containerName)
          log({ kind: 'deregister', containerName: req.containerName, reason: 'fatal' })
          void broker.stop()
        },
      })
      if (!result.ok) return { ok: false, reason: result.reason }
      brokers.set(req.containerName, result.broker)
      log({ kind: 'register', containerName: req.containerName })
      return { ok: true }
    })()
    inflightRegistrations.set(req.containerName, promise)
    try {
      return await promise
    } finally {
      inflightRegistrations.delete(req.containerName)
    }
  }

  const handleDeregister = async (req: { containerName: string }): Promise<Response> => {
    const broker = brokers.get(req.containerName)
    if (!broker) return { ok: true }
    brokers.delete(req.containerName)
    log({ kind: 'deregister', containerName: req.containerName, reason: 'requested' })
    await broker.stop()
    return { ok: true }
  }

  const handleList = (): Response => {
    const result: ListResult = {
      brokers: Array.from(brokers.values()).map((b) => ({
        containerName: b.containerName,
        forwardedPorts: b.forwardedPorts(),
        containerIp: b.containerIp,
      })),
    }
    return { ok: true, result }
  }

  const handleStatus = (req: { containerName: string }): Response => {
    const broker = brokers.get(req.containerName)
    if (!broker) return { ok: false, reason: `not registered: ${req.containerName}` }
    const result: StatusResult = {
      containerName: broker.containerName,
      containerIp: broker.containerIp,
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
  log({ kind: 'daemon-listening', socket: path })

  const gcTimer = setInterval(() => {
    if (stopped || brokers.size === 0) return
    void runGc()
  }, gcIntervalMs)

  const runGc = async (): Promise<void> => {
    for (const name of Array.from(brokers.keys())) {
      const alive = await containerExists(name).catch(() => false)
      if (alive) continue
      const broker = brokers.get(name)
      if (!broker) continue
      brokers.delete(name)
      log({ kind: 'deregister', containerName: name, reason: 'gone' })
      await broker.stop()
    }
  }

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
