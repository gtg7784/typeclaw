// PATH-shadow shim installed at the global bin path that `bun install -g
// agent-browser` previously occupied. Replaces the plugin's old prompt-nudge +
// bash-regex `tool.before` block, which was leaky (missed shell variations,
// bypassed by `typeclaw shell`, by spawned subprocesses, by the user typing
// it directly). Now ANY in-container `agent-browser` caller routes through
// here — the dashboard subcommand transparently gets the proxy in front,
// every other subcommand passes through unchanged.

import { existsSync } from 'node:fs'

import {
  AGENT_BROWSER_DASHBOARD_PROXY_PORT,
  AGENT_BROWSER_DASHBOARD_UPSTREAM_PORT,
  startDashboardProxy,
} from './dashboard-proxy'

export const REAL_BIN_ENV = 'TYPECLAW_AGENT_BROWSER_REAL_BIN'

export type DashboardIntent = 'start' | 'stop' | 'other'

export function classifyDashboardCommand(argv: readonly string[]): DashboardIntent {
  // Find the first non-flag token. `agent-browser` takes no pre-subcommand
  // global flags today; the loop is defensive against future ones.
  let dashboardIdx = -1
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('-')) continue
    if (arg !== 'dashboard') return 'other'
    dashboardIdx = i
    break
  }
  if (dashboardIdx === -1) return 'other'

  // Look for the next non-flag token after `dashboard`. Upstream treats a
  // missing subcommand as `start`, so we do too — that path needs the proxy.
  // `--port <n>` and `-p <n>` consume two argv entries; the value is not a
  // subcommand and must not be classified as one.
  for (let i = dashboardIdx + 1; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--port' || arg === '-p') {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    if (arg === 'stop') return 'stop'
    if (arg === 'start') return 'start'
    return 'other'
  }
  return 'start'
}

export function rewriteDashboardArgs(argv: readonly string[], upstreamPort: number): string[] {
  // Force --port to upstreamPort regardless of what the caller passed. The
  // proxy on AGENT_BROWSER_DASHBOARD_PROXY_PORT is the only externally
  // visible surface; honoring a user --port would let a caller bypass the
  // proxy by listening directly on the externally forwarded port. Insert
  // `start` explicitly when the caller relied on the implicit-start behavior
  // so the appended `--port` lands on a subcommand upstream accepts.
  const stripped: string[] = []
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === '--port' || arg === '-p') {
      i += 2
      continue
    }
    if (arg.startsWith('--port=')) {
      i += 1
      continue
    }
    stripped.push(arg)
    i += 1
  }

  const dashboardIdx = stripped.findIndex((a) => !a.startsWith('-'))
  const hasSubcommand = stripped.slice(dashboardIdx + 1).some((a) => !a.startsWith('-'))
  const out = hasSubcommand
    ? [...stripped]
    : [...stripped.slice(0, dashboardIdx + 1), 'start', ...stripped.slice(dashboardIdx + 1)]
  out.push('--port', String(upstreamPort))
  return out
}

export function resolveRealAgentBrowserBin(): string {
  // Set by the installer when it moves the upstream symlink aside. Honored
  // first so unit tests can point at a stub without touching the filesystem.
  const fromEnv = process.env[REAL_BIN_ENV]
  if (fromEnv && fromEnv.length > 0) return fromEnv

  // Fallback: `bun install -g agent-browser` ships per-platform native bins
  // under this stable path inside the bun image. The installer should have
  // stashed a copy/symlink, but if a user ran `typeclaw start` against an
  // image where the installer hasn't yet run, we can still find the real
  // bin and proxy correctly (the next plugin boot will install the shim).
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  const platform = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : null
  if (arch !== null && platform !== null) {
    const native = `/root/.bun/install/global/node_modules/agent-browser/bin/agent-browser-${platform}-${arch}`
    if (existsSync(native)) return native
  }

  throw new Error(
    `${REAL_BIN_ENV} is not set and no fallback agent-browser binary was found. ` +
      `The shim cannot resolve the real upstream binary; refusing to exec to avoid an infinite loop.`,
  )
}

export type ShimOptions = {
  argv?: readonly string[]
  realBin?: string
  proxyPort?: number
  upstreamPort?: number
  spawn?: (cmd: string[]) => { exited: Promise<number> }
  startProxy?: typeof startDashboardProxy
}

export async function runShim(opts: ShimOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2)
  const realBin = opts.realBin ?? resolveRealAgentBrowserBin()
  const proxyPort = opts.proxyPort ?? AGENT_BROWSER_DASHBOARD_PROXY_PORT
  const upstreamPort = opts.upstreamPort ?? AGENT_BROWSER_DASHBOARD_UPSTREAM_PORT
  const spawn = opts.spawn ?? defaultSpawn
  const startProxy = opts.startProxy ?? startDashboardProxy

  const intent = classifyDashboardCommand(argv)
  if (intent !== 'start') {
    return await spawn([realBin, ...argv]).exited
  }

  const rewritten = rewriteDashboardArgs(argv, upstreamPort)
  const proxy = startProxy({ listenPort: proxyPort, upstreamPort })
  try {
    return await spawn([realBin, ...rewritten]).exited
  } finally {
    // Always release the proxy port. If we leak it, the next dashboard call
    // (from this shim or a reboot of the same agent) sees `EADDRINUSE` and
    // the shim hard-fails — exactly the silent degradation we are trying
    // to eliminate.
    proxy.stop()
  }
}

function defaultSpawn(cmd: string[]): { exited: Promise<number> } {
  // Inherit stdio so the upstream binary's TUI/spinner/colors work. The
  // shim is meant to be invisible; intercepting stdio would make e.g.
  // `agent-browser open` look broken to the caller.
  const proc = Bun.spawn(cmd, { stdio: ['inherit', 'inherit', 'inherit'] })
  return { exited: proc.exited }
}

if (import.meta.main) {
  const code = await runShim()
  process.exit(code)
}
