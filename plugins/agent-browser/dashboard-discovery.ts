// Discovers the actual port the agent-browser dashboard daemon is listening
// on. Necessary because the previous design hardcoded 4849 in the proxy and
// trusted the shim to force upstream onto that port — but the shim is bypass-
// able (someone runs `bunx agent-browser dashboard --port 9999`, the binary
// gets invoked from a path that isn't shimmed, an old container leaves a
// stale daemon, etc.). The proxy now consults this module to find the
// dashboard wherever it actually is.
//
// Two-stage discovery, fastest signal first:
//
//   1. Hint file at PORT_HINT_PATH. The shim writes the port it asked
//      upstream to bind to (via the rewritten --port). If the file exists,
//      points at a port, AND that port currently has a LISTEN socket we
//      can fast-probe with HEAD /api/sessions, we use it. Zero I/O on the
//      hot path beyond a small file read.
//
//   2. Fallback: read the dashboard's own pidfile at DASHBOARD_PID_PATH
//      (written by upstream itself). If the PID is alive, scan
//      /proc/<pid>/fd for socket inodes, cross-reference with /proc/net/tcp
//      to find LISTEN sockets owned by that PID, drop the proxy's own port,
//      probe each remaining port with HEAD /api/sessions, return the
//      first that responds 2xx. Linux-only, which is fine — typeclaw runs
//      in a Linux container.
//
// The fallback is what makes "agent uses other port" work when the shim
// doesn't catch the call. Without it, the proxy is stuck at whatever port
// it was configured with and silently 502s on a moved dashboard.

import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'

export const PORT_HINT_PATH = '/tmp/typeclaw-agent-browser-upstream-port'
export const DASHBOARD_PID_PATH = '/root/.agent-browser/dashboard.pid'
const DEFAULT_PROBE_TIMEOUT_MS = 250

export type DiscoveryOptions = {
  hintPath?: string
  pidPath?: string
  excludePort?: number
  fetchImpl?: typeof fetch
  probeTimeoutMs?: number
  procfs?: ProcFs
}

export type ProcFs = {
  pidExists: (pid: number) => boolean
  listenInodesForPid: (pid: number) => Set<string>
  listenSockets: () => Array<{ port: number; inode: string }>
}

export async function discoverDashboardPort(opts: DiscoveryOptions = {}): Promise<number | null> {
  const hintPath = opts.hintPath ?? PORT_HINT_PATH
  const pidPath = opts.pidPath ?? DASHBOARD_PID_PATH
  const fetcher = opts.fetchImpl ?? fetch
  const probeTimeout = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const procfs = opts.procfs ?? defaultProcFs()

  const hint = readPortHint(hintPath)
  if (hint !== null && (await isDashboardPort(hint, fetcher, probeTimeout))) return hint

  const pidContents = readPidFile(pidPath)
  if (pidContents === null) return null
  if (!procfs.pidExists(pidContents)) return null

  const pidInodes = procfs.listenInodesForPid(pidContents)
  const candidates: number[] = []
  for (const socket of procfs.listenSockets()) {
    if (!pidInodes.has(socket.inode)) continue
    if (opts.excludePort !== undefined && socket.port === opts.excludePort) continue
    candidates.push(socket.port)
  }

  for (const port of candidates) {
    if (await isDashboardPort(port, fetcher, probeTimeout)) return port
  }
  return null
}

export function writePortHint(port: number, hintPath: string = PORT_HINT_PATH): void {
  Bun.write(hintPath, String(port))
}

function readPortHint(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
    return port
  } catch {
    return null
  }
}

function readPidFile(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid < 1) return null
    return pid
  } catch {
    return null
  }
}

async function isDashboardPort(port: number, fetcher: typeof fetch, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetcher(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'GET',
      signal: ctrl.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function defaultProcFs(): ProcFs {
  return {
    pidExists: (pid) => existsSync(`/proc/${pid}`),
    listenInodesForPid: (pid) => {
      const inodes = new Set<string>()
      const fdDir = `/proc/${pid}/fd`
      let entries: string[]
      try {
        entries = readdirSync(fdDir)
      } catch {
        return inodes
      }
      for (const entry of entries) {
        try {
          const target = readlinkSync(`${fdDir}/${entry}`)
          const match = target.match(/^socket:\[(\d+)\]$/)
          if (match) inodes.add(match[1]!)
        } catch {
          continue
        }
      }
      return inodes
    },
    listenSockets: () => {
      const out: Array<{ port: number; inode: string }> = []
      for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let raw: string
        try {
          raw = readFileSync(file, 'utf-8')
        } catch {
          continue
        }
        const lines = raw.split('\n').slice(1)
        for (const line of lines) {
          const cols = line.trim().split(/\s+/)
          if (cols.length < 10) continue
          if (cols[3] !== '0A') continue
          const local = cols[1] ?? ''
          const colonIdx = local.lastIndexOf(':')
          if (colonIdx < 0) continue
          const port = Number.parseInt(local.slice(colonIdx + 1), 16)
          if (!Number.isInteger(port) || port < 1 || port > 65_535) continue
          const inode = cols[9]
          if (inode === undefined) continue
          out.push({ port, inode })
        }
      }
      return out
    },
  }
}
