import { defaultDockerExec, type DockerExec } from '@/container'

import { startDetector, type Detector, type PortChange } from './detector'
import { startForwarder, type Forwarder, type ForwarderOptions, type ForwarderStartResult } from './forwarder'

export { ensureLogDir, logfilePath, pidfilePath, readPidfile, removePidfile, writePidfile } from './pidfile'
export { startForwarder, type Forwarder, type ForwarderOptions, type ForwarderStartResult } from './forwarder'
export { startDetector, parseListeningPorts, type Detector, type PortChange } from './detector'
export { spawnBrokerDetached, stopBrokerDetached } from './spawn'

export type ForwarderFactory = (opts: ForwarderOptions) => Promise<ForwarderStartResult>

export type BrokerLogEvent =
  | { kind: 'open'; hostPort: number; upstreamPort: number; upstreamHost: string }
  | { kind: 'close'; hostPort: number }
  | { kind: 'skip-excluded'; port: number }
  | { kind: 'skip-eaddrinuse'; port: number; reason: string }
  | { kind: 'ip-resolved'; containerIp: string }
  | { kind: 'ip-changed'; from: string; to: string }
  | { kind: 'detector-error'; message: string }
  | { kind: 'fatal'; message: string }

export type BrokerOptions = {
  containerName: string
  excludePorts: Set<number>
  exec?: DockerExec
  intervalMs?: number
  resolveIp?: ContainerIpResolver
  forwarderFactory?: ForwarderFactory
  onLog?: (event: BrokerLogEvent) => void
}

export type Broker = {
  containerIp: string
  stop: () => Promise<void>
}

export type ContainerIpResolver = (containerName: string, exec: DockerExec) => Promise<string | null>

export const defaultResolveIp: ContainerIpResolver = async (containerName, exec) => {
  const result = await exec([
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
    containerName,
  ])
  if (result.exitCode !== 0) return null
  const candidates = result.stdout
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
  return candidates[0] ?? null
}

export type StartBrokerResult = { ok: true; broker: Broker } | { ok: false; reason: string }

export async function startBroker(opts: BrokerOptions): Promise<StartBrokerResult> {
  const exec = opts.exec ?? defaultDockerExec
  const resolveIp = opts.resolveIp ?? defaultResolveIp
  const forwarderFactory = opts.forwarderFactory ?? startForwarder
  const log = opts.onLog ?? (() => {})

  const initialIp = await resolveIp(opts.containerName, exec)
  if (initialIp === null) {
    return { ok: false, reason: `unable to resolve IP for container ${opts.containerName}` }
  }
  log({ kind: 'ip-resolved', containerIp: initialIp })

  const forwarders = new Map<number, Forwarder>()
  let containerIp = initialIp
  let stopped = false
  let detector: Detector | null = null

  const handleChange = async (change: PortChange): Promise<void> => {
    if (stopped) return
    if (change.kind === 'open') {
      if (opts.excludePorts.has(change.port)) {
        log({ kind: 'skip-excluded', port: change.port })
        return
      }
      if (forwarders.has(change.port)) return
      const fr = await forwarderFactory({
        hostPort: change.port,
        upstreamHost: containerIp,
        upstreamPort: change.port,
      })
      if (!fr.ok) {
        log({ kind: 'skip-eaddrinuse', port: change.port, reason: fr.reason })
        return
      }
      forwarders.set(change.port, fr.forwarder)
      log({ kind: 'open', hostPort: change.port, upstreamHost: containerIp, upstreamPort: change.port })
      return
    }
    const existing = forwarders.get(change.port)
    if (!existing) return
    forwarders.delete(change.port)
    await existing.stop()
    log({ kind: 'close', hostPort: change.port })
  }

  detector = startDetector({
    containerName: opts.containerName,
    exec,
    intervalMs: opts.intervalMs,
    onChange: (change) => {
      void handleChange(change)
    },
    onError: (err) => {
      log({ kind: 'detector-error', message: err.message })
      void resolveIp(opts.containerName, exec).then((nextIp) => {
        if (stopped || nextIp === null) return
        if (nextIp !== containerIp) {
          log({ kind: 'ip-changed', from: containerIp, to: nextIp })
          containerIp = nextIp
        }
      })
    },
  })

  const broker: Broker = {
    containerIp: initialIp,
    stop: async () => {
      stopped = true
      if (detector) await detector.stop()
      const all = Array.from(forwarders.values())
      forwarders.clear()
      await Promise.all(all.map((f) => f.stop()))
    },
  }
  return { ok: true, broker }
}
