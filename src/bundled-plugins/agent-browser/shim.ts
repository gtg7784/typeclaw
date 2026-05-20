// PATH-shadow shim installed at the global bin path that `bun install -g
// agent-browser` previously occupied. Replaces the plugin's old prompt-nudge +
// bash-regex `tool.before` block, which was leaky (missed shell variations,
// bypassed by `typeclaw shell`, by spawned subprocesses, by the user typing
// it directly). Now ANY in-container `agent-browser` caller routes through
// here — the dashboard subcommand transparently gets its --port rewritten
// onto the agent-process-owned proxy's upstream port, every other subcommand
// passes through unchanged. The proxy itself lives in the long-lived agent
// process (see src/bundled-plugins/agent-browser/index.ts); the shim does NOT own its
// lifecycle, because `agent-browser dashboard start` daemonizes upstream and
// returns immediately — a shim-owned proxy would die the moment start exits.

import { existsSync } from 'node:fs'

import { writePortHint } from './dashboard-discovery'
import { AGENT_BROWSER_DASHBOARD_UPSTREAM_PORT } from './dashboard-proxy'

export const REAL_BIN_ENV = 'TYPECLAW_AGENT_BROWSER_REAL_BIN'

// Recent desktop Chrome on Linux x86_64. The shim runs inside the TypeClaw
// container (always Linux), so a macOS or Windows UA would mismatch the TCP
// fingerprint, Accept-Language, and JS-side platform — itself a bot signal on
// stricter sites (Cloudflare, Akamai, PerimeterX). `X11; Linux x86_64` is
// also correct on linux/arm64 hosts: Chrome on Linux does not expose ARM in
// the UA string at all (verified against current Chrome 131 releases).
// The upstream binary defaults to a UA that includes "HeadlessChrome" /
// a stale Chromium build, which is widely fingerprinted as a bot and
// silently triggers CAPTCHAs, 403s, blank pages, and A/B-test misrouting.
// Bump on Chrome major releases — same hygiene as the curl-impersonate pin
// in src/init/dockerfile.ts.
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const USER_AGENT_ENV = 'AGENT_BROWSER_USER_AGENT'

export function hasUserAgentFlag(argv: readonly string[]): boolean {
  // Matches both `--user-agent <val>` and `--user-agent=<val>`. The upstream
  // CLI does not document a short alias for --user-agent today (verified via
  // `agent-browser --help`), so we only check the long form.
  for (const arg of argv) {
    if (arg === '--user-agent' || arg.startsWith('--user-agent=')) return true
  }
  return false
}

export function injectUserAgentEnv(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  defaultUa: string = DEFAULT_USER_AGENT,
): void {
  // Upstream's precedence is CLI flag > env > default. We only inject the
  // env when BOTH layers above it are absent so:
  //   - explicit `--user-agent foo` wins (mobile testing, intentional bot UA)
  //   - operator-set AGENT_BROWSER_USER_AGENT wins (per-shell override)
  //   - default UA fills the otherwise-empty slot
  // `set device "iPhone 14"` is unaffected: it sets UA via CDP at runtime,
  // not through this env var, so our injection doesn't fight device emulation.
  if (env[USER_AGENT_ENV] !== undefined && env[USER_AGENT_ENV] !== '') return
  if (hasUserAgentFlag(argv)) return
  env[USER_AGENT_ENV] = defaultUa
}

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
  // missing subcommand as `start`, so we do too. `--port <n>` and `-p <n>`
  // consume two argv entries; the value is not a subcommand and must not be
  // classified as one.
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
  // proxy on AGENT_BROWSER_DASHBOARD_PROXY_PORT (4848) is the only externally
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
  // stashed a copy/symlink, but if the shim runs before the plugin's
  // installer ever did (e.g. first agent boot), we can still find the real
  // bin and the next plugin boot will install the shim properly.
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
  upstreamPort?: number
  spawn?: (cmd: string[]) => { exited: Promise<number> }
  env?: Record<string, string | undefined>
}

export async function runShim(opts: ShimOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2)
  const realBin = opts.realBin ?? resolveRealAgentBrowserBin()
  const upstreamPort = opts.upstreamPort ?? AGENT_BROWSER_DASHBOARD_UPSTREAM_PORT
  const spawn = opts.spawn ?? defaultSpawn
  const env = opts.env ?? process.env

  injectUserAgentEnv(argv, env)

  const intent = classifyDashboardCommand(argv)
  if (intent !== 'start') {
    return await spawn([realBin, ...argv]).exited
  }

  // Record the rewritten port to the hint file so the long-lived proxy can
  // use it as the fast-path upstream lookup. The proxy still falls back to
  // procfs discovery if the hint is wrong, but the hint avoids that work
  // on the common path where the shim is the one starting the dashboard.
  try {
    writePortHint(upstreamPort)
  } catch {
    // Hint is an optimization; failure to write it is non-fatal.
  }

  const rewritten = rewriteDashboardArgs(argv, upstreamPort)
  return await spawn([realBin, ...rewritten]).exited
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
