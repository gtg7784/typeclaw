import type { DockerExec } from '@/container'

export type ListeningSocket = {
  port: number
  // `false` means every listener for this port is bound to loopback inside the
  // container (IPv4 127.0.0.1 or IPv6 ::1). The host-side broker dials the
  // container's bridge IP, which the kernel will not route to a loopback-only
  // socket, so such ports must not be forwarded.
  reachableFromBridge: boolean
}

export type PortChange = { kind: 'open'; port: number; reachableFromBridge: boolean } | { kind: 'close'; port: number }

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

const IPV4_LOOPBACK_LE = '0100007F'
// IPv6 ::1 in /proc/net/tcp6 byte order: each 32-bit word is printed
// big-endian (`00000000`), but the four words appear in little-endian word
// order, so ::1 (last word = 1) lands as `...00000000 01000000` with the `01`
// in the final word's least-significant position.
const IPV6_LOOPBACK_LE = '00000000000000000000000001000000'
// IPv4-mapped IPv6 loopback (::ffff:127.0.0.1), as emitted by dual-stack
// listeners that bind to 127.0.0.1 on AF_INET6.
const IPV4_MAPPED_LOOPBACK_LE = '0000000000000000FFFF00000100007F'

function isLoopbackAddress(addrHex: string): boolean {
  const upper = addrHex.toUpperCase()
  if (upper.length === 8) return upper === IPV4_LOOPBACK_LE
  if (upper.length === 32) return upper === IPV6_LOOPBACK_LE || upper === IPV4_MAPPED_LOOPBACK_LE
  return false
}

export function parseListeningSockets(procContent: string): Map<number, ListeningSocket> {
  const byPort = new Map<number, ListeningSocket>()
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
    const addrHex = local.slice(0, colon)
    const portHex = local.slice(colon + 1)
    const port = Number.parseInt(portHex, 16)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue
    const thisListenerReachable = !isLoopbackAddress(addrHex)
    const existing = byPort.get(port)
    // Aggregate across IPv4/IPv6 rows: a port is bridge-reachable if ANY
    // listener for it is bound to a non-loopback address. This handles the
    // common case of `0.0.0.0:N` (IPv4) + `::1:N` (IPv6) where one listener
    // is exposed and the other is loopback.
    if (existing) {
      if (thisListenerReachable && !existing.reachableFromBridge) {
        byPort.set(port, { port, reachableFromBridge: true })
      }
    } else {
      byPort.set(port, { port, reachableFromBridge: thisListenerReachable })
    }
  }
  return byPort
}

// Backward-compatible thin wrapper. Prefer `parseListeningSockets` for new
// callers that need to know whether a port is reachable from the bridge IP.
export function parseListeningPorts(procContent: string): Set<number> {
  return new Set(parseListeningSockets(procContent).keys())
}

export function startDetector(opts: DetectorOptions): Detector {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES
  let known = new Map<number, ListeningSocket>()
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

    const next = parseListeningSockets(result.stdout)
    for (const [port, sock] of next) {
      const prev = known.get(port)
      if (!prev) {
        opts.onChange({ kind: 'open', port, reachableFromBridge: sock.reachableFromBridge })
      } else if (prev.reachableFromBridge !== sock.reachableFromBridge) {
        // A port previously seen as loopback-only became bridge-reachable
        // (or vice versa) because the user added/removed a listener. Emit a
        // close+open pair so the broker reinstalls (or removes) the forwarder.
        opts.onChange({ kind: 'close', port })
        opts.onChange({ kind: 'open', port, reachableFromBridge: sock.reachableFromBridge })
      }
    }
    for (const port of known.keys()) {
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
