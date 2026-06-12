// PATH-shadow shim installed at the global bin path that `bun install -g
// agent-browser` previously occupied. Replaces the plugin's old prompt-nudge +
// bash-regex `tool.before` block, which was leaky (missed shell variations,
// bypassed by `typeclaw shell`, by spawned subprocesses, by the user typing
// it directly). Now ANY in-container `agent-browser` caller routes through
// here and gets the anti-fingerprint User-Agent default before execing the
// real upstream binary unchanged.

import { existsSync } from 'node:fs'

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
  spawn?: (cmd: string[]) => { exited: Promise<number> }
  env?: Record<string, string | undefined>
}

export async function runShim(opts: ShimOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2)
  const realBin = opts.realBin ?? resolveRealAgentBrowserBin()
  const spawn = opts.spawn ?? defaultSpawn
  const env = opts.env ?? process.env

  injectUserAgentEnv(argv, env)
  return await spawn([realBin, ...argv]).exited
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
