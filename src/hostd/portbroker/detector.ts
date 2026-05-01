import type { DockerExec } from '@/container'

export type PortChange = { kind: 'open'; port: number } | { kind: 'close'; port: number }

export type DetectorOptions = {
  containerName: string
  exec: DockerExec
  intervalMs?: number
  maxConsecutiveFailures?: number
  onChange: (change: PortChange) => void
  onError?: (err: Error) => void
  onFatal?: (err: Error) => void
}

export type Detector = {
  stop: () => Promise<void>
}

const TCP_LISTEN_STATE = '0A'
const DEFAULT_INTERVAL_MS = 750
const DEFAULT_MAX_FAILURES = 5
const PROC_NET_CMD = ['exec', '__name__', 'sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null']

export function parseListeningPorts(procContent: string): Set<number> {
  const ports = new Set<number>()
  for (const line of procContent.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const cols = trimmed.split(/\s+/)
    if (cols.length < 4) continue
    if (!/^\d+:$/.test(cols[0]!)) continue
    const local = cols[1]
    const state = cols[3]
    if (state !== TCP_LISTEN_STATE) continue
    if (!local) continue
    const colon = local.lastIndexOf(':')
    if (colon < 0) continue
    const portHex = local.slice(colon + 1)
    const port = Number.parseInt(portHex, 16)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue
    ports.add(port)
  }
  return ports
}

export function startDetector(opts: DetectorOptions): Detector {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES
  let known = new Set<number>()
  let consecutiveFailures = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null

  const recordFailure = (reason: string): void => {
    consecutiveFailures += 1
    if (consecutiveFailures >= maxFailures) {
      stopped = true
      opts.onFatal?.(new Error(`docker exec failed ${consecutiveFailures} times: ${reason}`))
      return
    }
    opts.onError?.(new Error(reason))
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    const cmd = PROC_NET_CMD.map((arg) => (arg === '__name__' ? opts.containerName : arg))
    let result: Awaited<ReturnType<DockerExec>>
    try {
      result = await opts.exec(cmd)
    } catch (error) {
      if (stopped) return
      recordFailure(error instanceof Error ? error.message : String(error))
      return
    }
    if (stopped) return

    if (result.exitCode !== 0) {
      recordFailure(result.stderr.trim() || `exit ${result.exitCode}`)
      return
    }
    consecutiveFailures = 0

    const next = parseListeningPorts(result.stdout)
    for (const port of next) {
      if (!known.has(port)) opts.onChange({ kind: 'open', port })
    }
    for (const port of known) {
      if (!next.has(port)) opts.onChange({ kind: 'close', port })
    }
    known = next
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      inflight = tick().finally(() => {
        inflight = null
        schedule()
      })
    }, interval)
  }

  inflight = tick().finally(() => {
    inflight = null
    schedule()
  })

  return {
    stop: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (inflight) await inflight.catch(() => {})
    },
  }
}
