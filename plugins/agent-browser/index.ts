import { join } from 'node:path'

import { definePlugin } from '@/plugin'
import { bindWithForward } from '@/portbroker'

import { AGENT_BROWSER_DASHBOARD_PROXY_PORT, startDashboardProxy, type DashboardProxy } from './dashboard-proxy'
import { installShim, KNOWN_BIN_PATHS, type InstallShimResult } from './shim-install'

type SafeResult = InstallShimResult | { kind: 'error'; binPath: string; error: unknown }

const PROXY_PORT_HINT_PATH = '/tmp/typeclaw-agent-browser-proxy-port'
const PORT_CANDIDATE_RANGE = 10

let activeProxy: DashboardProxy | null = null

export default definePlugin({
  plugin: async (ctx) => {
    for (const binPath of Object.values(KNOWN_BIN_PATHS)) {
      logInstallResult(ctx.logger, safeInstallShim(binPath))
    }

    if (activeProxy === null) {
      const bound = await bindProxyOnFirstFreePort(ctx.logger)
      if (bound !== null) {
        activeProxy = bound.proxy
        recordProxyPort(bound.port, ctx.logger)
        ctx.logger.info(
          `dashboard proxy listening on port ${bound.port}` +
            (bound.hostPort !== null ? ` (forwarded to host:${bound.hostPort})` : ''),
        )
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

async function bindProxyOnFirstFreePort(logger: {
  info: (msg: string) => void
  warn: (msg: string) => void
}): Promise<{ proxy: DashboardProxy; port: number; hostPort: number | null } | null> {
  const config = readPortConfig()
  const candidates = buildCandidatePorts(config.listenPort)
  // Auto-discovery only — we never pin upstream here. The proxy reads
  // /tmp/typeclaw-agent-browser-upstream-port (written by the shim) and
  // falls back to procfs. TYPECLAW_DASHBOARD_UPSTREAM_PORT remains as a
  // unit-test escape hatch only.
  const upstreamOverride = config.upstreamPort

  const result = await bindWithForward<DashboardProxy>({
    candidates,
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
    return null
  }
  return { proxy: result.resource, port: result.port, hostPort: result.hostPort }
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
