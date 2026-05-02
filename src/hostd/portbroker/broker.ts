import { defaultDockerExec, type DockerExec } from '@/container'

import { startDetector, type Detector, type PortChange } from './detector'
import { startForwarder, type Forwarder, type ForwarderOptions, type ForwarderStartResult } from './forwarder'
import { startLoopbackProxy, type LoopbackProxy, type LoopbackProxyFactory } from './loopback-proxy'

export type ForwarderFactory = (opts: ForwarderOptions) => Promise<ForwarderStartResult>

export type BrokerLogEvent =
  | { kind: 'open'; containerName: string; hostPort: number; upstreamPort: number; upstreamHost: string }
  | { kind: 'close'; containerName: string; hostPort: number }
  | { kind: 'skip-excluded'; containerName: string; port: number }
  | { kind: 'skip-loopback'; containerName: string; port: number }
  | { kind: 'loopback-proxy-open'; containerName: string; port: number; listenHost: string }
  | { kind: 'loopback-proxy-failed'; containerName: string; port: number; reason: string }
  | { kind: 'loopback-proxy-exited'; containerName: string; port: number; reason: string }
  | { kind: 'skip-eaddrinuse'; containerName: string; port: number; reason: string }
  | { kind: 'ip-resolved'; containerName: string; containerIp: string }
  | { kind: 'ip-changed'; containerName: string; from: string; to: string }
  | { kind: 'detector-error'; containerName: string; message: string }
  | { kind: 'fatal'; containerName: string; message: string }

export type ContainerIpResolver = (containerName: string, exec: DockerExec) => Promise<string | null>

export type BrokerOptions = {
  containerName: string
  excludePorts: Set<number>
  loopbackPorts?: Set<number>
  exec?: DockerExec
  intervalMs?: number
  maxConsecutiveFailures?: number
  resolveIp?: ContainerIpResolver
  forwarderFactory?: ForwarderFactory
  loopbackProxyFactory?: LoopbackProxyFactory
  onLog?: (event: BrokerLogEvent) => void
  onFatal?: () => void
}

export type Broker = {
  containerName: string
  containerIp: () => string
  forwardedPorts: () => number[]
  stop: () => Promise<void>
}

type Exposure = {
  forwarder: Forwarder
  loopbackProxy: LoopbackProxy | null
  reachableFromBridge: boolean
}

export type StartBrokerResult = { ok: true; broker: Broker } | { ok: false; reason: string }

// `docker inspect --format '{{json .NetworkSettings.Networks}}' <name>` returns
// a single JSON object keyed by network name. Picking the first key by
// Object.keys order is non-deterministic across Docker versions; sorting yields
// stable output. We prefer named-bridge networks over the default `bridge` so
// that custom-network deployments resolve to the right interface.
export const defaultResolveIp: ContainerIpResolver = async (containerName, exec) => {
  const result = await exec(['inspect', '--format', '{{json .NetworkSettings.Networks}}', containerName])
  if (result.exitCode !== 0) return null
  let parsed: Record<string, { IPAddress?: unknown }>
  try {
    parsed = JSON.parse(result.stdout.trim()) as Record<string, { IPAddress?: unknown }>
  } catch {
    return null
  }
  const names = Object.keys(parsed).sort((a, b) => {
    if (a === 'bridge' && b !== 'bridge') return 1
    if (b === 'bridge' && a !== 'bridge') return -1
    return a.localeCompare(b)
  })
  for (const name of names) {
    const entry = parsed[name]
    const ip = entry && typeof entry.IPAddress === 'string' ? entry.IPAddress : ''
    if (ip.length > 0) return ip
  }
  return null
}

export async function startBroker(opts: BrokerOptions): Promise<StartBrokerResult> {
  const exec = opts.exec ?? defaultDockerExec
  const resolveIp = opts.resolveIp ?? defaultResolveIp
  const forwarderFactory = opts.forwarderFactory ?? startForwarder
  const loopbackProxyFactory = opts.loopbackProxyFactory ?? startLoopbackProxy
  const log = opts.onLog ?? (() => {})
  const loopbackPorts = opts.loopbackPorts ?? new Set<number>()

  const initialIp = await resolveIp(opts.containerName, exec)
  if (initialIp === null) {
    return { ok: false, reason: `unable to resolve IP for container ${opts.containerName}` }
  }
  log({ kind: 'ip-resolved', containerName: opts.containerName, containerIp: initialIp })

  const exposures = new Map<number, Exposure>()
  let containerIp = initialIp
  let stopped = false
  let detector: Detector | null = null
  // Promise chain serializes change handling so concurrent open/close/IP-reset
  // events for the same broker can never observe partial state. Each operation
  // awaits the previous one before mutating `exposures` or `containerIp`.
  let serial: Promise<void> = Promise.resolve()

  const enqueue = (op: () => Promise<void>): void => {
    serial = serial.then(op).catch((err: unknown) => {
      log({
        kind: 'detector-error',
        containerName: opts.containerName,
        message: `serialized op failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    })
  }

  const installForwarder = async (port: number, reachableFromBridge: boolean): Promise<void> => {
    if (stopped) return
    if (opts.excludePorts.has(port)) {
      log({ kind: 'skip-excluded', containerName: opts.containerName, port })
      return
    }
    let loopbackProxy: LoopbackProxy | null = null
    if (!reachableFromBridge) {
      if (!loopbackPorts.has(port)) {
        log({ kind: 'skip-loopback', containerName: opts.containerName, port })
        return
      }
      let ownedProxy: LoopbackProxy | null = null
      const proxyResult = await loopbackProxyFactory({
        containerName: opts.containerName,
        listenHost: containerIp,
        port,
        onExit: (reason) => {
          enqueue(async () => {
            if (stopped) return
            const current = exposures.get(port)
            if (!current || current.loopbackProxy !== ownedProxy) return
            exposures.delete(port)
            await current.forwarder.stop()
            log({ kind: 'loopback-proxy-exited', containerName: opts.containerName, port, reason })
          })
        },
      })
      if (!proxyResult.ok) {
        log({ kind: 'loopback-proxy-failed', containerName: opts.containerName, port, reason: proxyResult.reason })
        return
      }
      ownedProxy = proxyResult.proxy
      loopbackProxy = proxyResult.proxy
      log({ kind: 'loopback-proxy-open', containerName: opts.containerName, port, listenHost: containerIp })
    }
    if (exposures.has(port)) {
      if (loopbackProxy) await loopbackProxy.stop()
      return
    }
    if (!reachableFromBridge && loopbackProxy === null) {
      log({ kind: 'skip-loopback', containerName: opts.containerName, port })
      return
    }
    const fr = await forwarderFactory({
      hostPort: port,
      upstreamHost: containerIp,
      upstreamPort: port,
    })
    if (stopped) {
      if (fr.ok) await fr.forwarder.stop()
      if (loopbackProxy) await loopbackProxy.stop()
      return
    }
    if (!fr.ok) {
      if (loopbackProxy) await loopbackProxy.stop()
      log({ kind: 'skip-eaddrinuse', containerName: opts.containerName, port, reason: fr.reason })
      return
    }
    exposures.set(port, { forwarder: fr.forwarder, loopbackProxy, reachableFromBridge })
    log({
      kind: 'open',
      containerName: opts.containerName,
      hostPort: port,
      upstreamHost: containerIp,
      upstreamPort: port,
    })
  }

  const removeForwarder = async (port: number): Promise<void> => {
    const existing = exposures.get(port)
    if (!existing) return
    exposures.delete(port)
    await existing.forwarder.stop()
    if (existing.loopbackProxy) await existing.loopbackProxy.stop()
    log({ kind: 'close', containerName: opts.containerName, hostPort: port })
  }

  const resetForwardersForNewIp = async (nextIp: string): Promise<void> => {
    if (stopped) return
    const ports = Array.from(exposures.entries()).map(([port, exposure]) => ({
      port,
      reachableFromBridge: exposure.reachableFromBridge,
    }))
    const old = Array.from(exposures.values())
    exposures.clear()
    await Promise.all(old.map((f) => Promise.all([f.forwarder.stop(), f.loopbackProxy?.stop() ?? Promise.resolve()])))
    log({ kind: 'ip-changed', containerName: opts.containerName, from: containerIp, to: nextIp })
    containerIp = nextIp
    for (const { port, reachableFromBridge } of ports) await installForwarder(port, reachableFromBridge)
  }

  detector = startDetector({
    containerName: opts.containerName,
    exec,
    intervalMs: opts.intervalMs,
    maxConsecutiveFailures: opts.maxConsecutiveFailures,
    onChange: (change: PortChange) => {
      enqueue(() =>
        change.kind === 'open'
          ? installForwarder(change.port, change.reachableFromBridge)
          : removeForwarder(change.port),
      )
    },
    onError: (err) => {
      log({ kind: 'detector-error', containerName: opts.containerName, message: err.message })
      enqueue(async () => {
        if (stopped) return
        const nextIp = await resolveIp(opts.containerName, exec)
        if (stopped || nextIp === null) return
        if (nextIp !== containerIp) await resetForwardersForNewIp(nextIp)
      })
    },
    onFatal: (err) => {
      log({ kind: 'fatal', containerName: opts.containerName, message: err.message })
      opts.onFatal?.()
    },
  })

  const broker: Broker = {
    containerName: opts.containerName,
    containerIp: () => containerIp,
    forwardedPorts: () => Array.from(exposures.keys()),
    stop: async () => {
      stopped = true
      await serial.catch(() => {})
      if (detector) await detector.stop()
      const all = Array.from(exposures.values())
      exposures.clear()
      await Promise.all(all.map((f) => Promise.all([f.forwarder.stop(), f.loopbackProxy?.stop() ?? Promise.resolve()])))
    },
  }
  return { ok: true, broker }
}
