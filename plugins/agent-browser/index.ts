import { join } from 'node:path'

import { definePlugin } from '@/plugin'

import {
  AGENT_BROWSER_DASHBOARD_PROXY_PORT,
  AGENT_BROWSER_DASHBOARD_UPSTREAM_PORT,
  startDashboardProxy,
  type DashboardProxy,
} from './dashboard-proxy'
import { installShim, KNOWN_BIN_PATHS, type InstallShimResult } from './shim-install'

type SafeResult = InstallShimResult | { kind: 'error'; binPath: string; error: unknown }

let activeProxy: DashboardProxy | null = null

export default definePlugin({
  plugin: async (ctx) => {
    for (const binPath of Object.values(KNOWN_BIN_PATHS)) {
      logInstallResult(ctx.logger, safeInstallShim(binPath))
    }

    // The proxy lives in the long-lived agent process, NOT in the per-call
    // shim. `agent-browser dashboard start` daemonizes the upstream and
    // returns immediately, so a shim-owned proxy would tear down the moment
    // the start command exits — leaving 4849 alive but 4848 dead. Binding
    // here means the proxy is up the whole time the agent is up, regardless
    // of how many times the dashboard is started/stopped.
    if (activeProxy === null) {
      activeProxy = safeStartProxy(ctx.logger, readPortConfig())
      if (activeProxy !== null) {
        ctx.logger.info(`dashboard proxy listening on port ${activeProxy.server.port ?? '?'}`)
      }
    }

    return {
      skillsDirs: [join(import.meta.dir, 'skills')],
    }
  },
})

export function __resetProxyForTesting(): void {
  activeProxy?.stop()
  activeProxy = null
}

type PortConfig = { listenPort: number; upstreamPort: number }

function readPortConfig(): PortConfig {
  return {
    listenPort: numberFromEnv('TYPECLAW_DASHBOARD_PROXY_PORT', AGENT_BROWSER_DASHBOARD_PROXY_PORT),
    upstreamPort: numberFromEnv('TYPECLAW_DASHBOARD_UPSTREAM_PORT', AGENT_BROWSER_DASHBOARD_UPSTREAM_PORT),
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return fallback
  return parsed
}

function safeStartProxy(logger: { warn: (msg: string) => void }, config: PortConfig): DashboardProxy | null {
  try {
    return startDashboardProxy(config)
  } catch (error) {
    logger.warn(
      `failed to bind dashboard proxy on port ${config.listenPort}: ${String(error)}; ` +
        `remote dashboard access will not work until restart`,
    )
    return null
  }
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
