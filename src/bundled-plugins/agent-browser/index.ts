import { join } from 'node:path'

import { definePlugin } from '@/plugin'
import { bindWithForward } from '@/portbroker'

import { AGENT_BROWSER_DASHBOARD_PROXY_PORT, startDashboardProxy, type DashboardProxy } from './dashboard-proxy'
import { installShim, KNOWN_BIN_PATHS, type InstallShimResult } from './shim-install'

type SafeResult = InstallShimResult | { kind: 'error'; binPath: string; error: unknown }

const PROXY_PORT_HINT_PATH = '/tmp/typeclaw-agent-browser-proxy-port'
const PORT_CANDIDATE_RANGE = 10
const BROKER_HANDSHAKE_DELAY_MS = 1_000
const FORWARD_RESULT_TIMEOUT_MS = 10_000

let activeProxy: DashboardProxy | null = null
let bindingInFlight: Promise<void> | null = null

export default definePlugin({
  plugin: async (ctx) => {
    for (const binPath of Object.values(KNOWN_BIN_PATHS)) {
      logInstallResult(ctx.logger, safeInstallShim(binPath))
    }

    // Kick off the proxy bind in the background and let the plugin factory
    // return immediately. Two reasons:
    //   1. The container-side broker is created AFTER pluginsLoaded.markBooted()
    //      runs (see src/run/index.ts). If we awaited bindWithForward here, we
    //      would block the boot sequence past 20s of timeouts before the broker
    //      even existed to send forward-result events.
    //   2. The dashboard isn't typically used at boot — the user runs
    //      `agent-browser dashboard start` later. The proxy has plenty of time
    //      to settle before its first request.
    if (activeProxy === null && bindingInFlight === null) {
      bindingInFlight = bindProxyAfterBrokerSettles(ctx.logger).finally(() => {
        bindingInFlight = null
      })
    }

    return {
      skillsDirs: [join(import.meta.dir, 'skills')],
    }
  },
})

export function __resetProxyForTesting(): void {
  activeProxy?.stop()
  activeProxy = null
  bindingInFlight = null
}

export function __waitForProxyBindForTesting(): Promise<void> {
  return bindingInFlight ?? Promise.resolve()
}

async function bindProxyAfterBrokerSettles(logger: {
  info: (msg: string) => void
  warn: (msg: string) => void
}): Promise<void> {
  // Give the run-loop time to construct the container broker and let it
  // complete its WS handshake with hostd. Without this the first candidate
  // bind fires before the broker is ready, the bus never delivers a result,
  // and we waste the full timeout × candidate-count budget tearing down
  // every port in the range. The exact delay isn't load-bearing — anything
  // longer than the broker's connect+hello round-trip works.
  if (defaultBrokerEnabled()) {
    await Bun.sleep(BROKER_HANDSHAKE_DELAY_MS)
  }

  const config = readPortConfig()
  const candidates = buildCandidatePorts(config.listenPort)
  const upstreamOverride = config.upstreamPort

  const result = await bindWithForward<DashboardProxy>({
    candidates,
    timeoutMs: FORWARD_RESULT_TIMEOUT_MS,
    factory: (port) => {
      try {
        const proxy = startDashboardProxy({ listenPort: port, upstreamPort: upstreamOverride })
        return Promise.resolve({ resource: proxy, close: () => proxy.stop() })
      } catch (error) {
        logger.warn(`bind ${port} failed: ${String(error)}`)
        return Promise.resolve(null)
      }
    },
    onLog: (msg) => logger.info(`[bind-with-forward] ${msg}`),
  })

  if (result === null) {
    logger.warn(
      `could not allocate a host-forwardable dashboard proxy port from ${candidates[0]}-${candidates[candidates.length - 1]}; ` +
        `remote dashboard access will not work until another container releases its port`,
    )
    return
  }

  activeProxy = result.resource
  recordProxyPort(result.port, logger)
  logger.info(
    `dashboard proxy listening on port ${result.port}` +
      (result.hostPort !== null ? ` (forwarded to host:${result.hostPort})` : ''),
  )
}

function defaultBrokerEnabled(): boolean {
  const token = process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
  return token !== undefined && token.length > 0
}

function buildCandidatePorts(start: number): number[] {
  const out: number[] = []
  for (let i = 0; i < PORT_CANDIDATE_RANGE; i += 1) out.push(start + i)
  return out
}

function recordProxyPort(port: number, logger: { warn: (msg: string) => void }): void {
  try {
    Bun.write(PROXY_PORT_HINT_PATH, String(port))
  } catch (error) {
    // Hint is informational (lets a future `typeclaw status` or a human shell
    // session report which port to open). Failure is non-fatal.
    logger.warn(`failed to write ${PROXY_PORT_HINT_PATH}: ${String(error)}`)
  }
}

type PortConfig = { listenPort: number; upstreamPort: number | undefined }

function readPortConfig(): PortConfig {
  const overrideUpstream = process.env['TYPECLAW_DASHBOARD_UPSTREAM_PORT']
  return {
    listenPort: numberFromEnv('TYPECLAW_DASHBOARD_PROXY_PORT', AGENT_BROWSER_DASHBOARD_PROXY_PORT),
    upstreamPort:
      overrideUpstream === undefined || overrideUpstream === '' ? undefined : numberOrUndefined(overrideUpstream),
  }
}

function numberOrUndefined(raw: string): number | undefined {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return undefined
  return parsed
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return fallback
  return parsed
}

function safeInstallShim(binPath: string): SafeResult {
  try {
    return installShim({ binPath })
  } catch (error) {
    return { kind: 'error', binPath, error }
  }
}

function logInstallResult(
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  result: SafeResult,
): void {
  if (result.kind === 'installed') {
    logger.info(`installed agent-browser shim at ${result.binPath} (real bin: ${result.realBin})`)
    return
  }
  if (result.kind === 'already-installed') {
    logger.info(`agent-browser shim already installed at ${result.binPath}`)
    return
  }
  if (result.kind === 'no-upstream') {
    logger.info(`no agent-browser binary at ${result.binPath}; skipping`)
    return
  }
  logger.warn(`failed to install agent-browser shim at ${result.binPath}: ${String(result.error)}`)
}
