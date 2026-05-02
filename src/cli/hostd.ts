import { defineCommand } from 'citty'

import { loadConfigSync, validateConfig } from '@/config'
import { start, stop } from '@/container'
import type { BrokerLogEvent } from '@/hostd'
import { startDaemon, type DaemonLogEvent } from '@/hostd/daemon'
import type { SupervisorLogEvent } from '@/hostd/supervisor'
import { computeSourceVersion, resolveSrcRoot, UNVERSIONED_SENTINEL } from '@/hostd/version'

export const hostdCommand = defineCommand({
  meta: {
    name: '_hostd',
    description: 'internal: host-side typeclaw daemon (do not invoke directly)',
    hidden: true,
  },
  async run() {
    const brokerEntry = process.argv[1] ?? ''
    const srcRoot = resolveSrcRoot(brokerEntry)
    const version = srcRoot === null ? UNVERSIONED_SENTINEL : await computeSourceVersion({ srcRoot })

    const daemon = await startDaemon({
      onLog: (e) => console.log(formatLog(e)),
      version,
      onShutdown: () => process.exit(0),
      restart: async ({ containerName, cwd }) => {
        const validated = validateConfig(cwd)
        if (!validated.ok) {
          return { ok: false, reason: `invalid config for ${containerName}: ${validated.reason}` }
        }
        const stopResult = await stop({ cwd })
        if (!stopResult.ok) return { ok: false, reason: `stop failed: ${stopResult.reason}` }

        const cfg = loadConfigSync(cwd)
        const startResult = await start({
          cwd,
          preferredHostPort: cfg.port,
          autoForward: cfg.autoForward,
          autoForwardExclude: cfg.autoForwardExclude,
          brokerEntry,
        })
        if (!startResult.ok) return { ok: false, reason: `start failed: ${startResult.reason}` }
        return { ok: true }
      },
    })

    const shutdown = (): void => {
      void daemon.stop().then(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    await new Promise<void>(() => {})
  },
})

function formatLog(event: BrokerLogEvent | DaemonLogEvent | SupervisorLogEvent): string {
  switch (event.kind) {
    case 'daemon-listening':
      return `[hostd] listening on ${event.socket}`
    case 'daemon-stopping':
      return `[hostd] stopping`
    case 'shutdown-requested':
      return `[hostd] shutdown requested (version drift); exiting so the next CLI call respawns`
    case 'register':
      return `[hostd] registered ${event.containerName}`
    case 'deregister':
      return `[hostd] deregistered ${event.containerName} (${event.reason})`
    case 'restart-scheduled':
      return `[hostd] restart scheduled for ${event.containerName}`
    case 'restart-completed':
      return `[hostd] restart completed for ${event.containerName}`
    case 'restart-failed':
      return `[hostd] restart failed for ${event.containerName}: ${event.reason}`
    case 'open':
      return `[${event.containerName}] forwarding localhost:${event.hostPort} -> ${event.upstreamHost}:${event.upstreamPort}`
    case 'close':
      return `[${event.containerName}] released localhost:${event.hostPort}`
    case 'skip-excluded':
      return `[${event.containerName}] skipping :${event.port} (excluded)`
    case 'skip-loopback':
      return `[${event.containerName}] skipping :${event.port} (bound to 127.0.0.1 inside the container; add it to autoForwardLoopback to expose it)`
    case 'loopback-proxy-open':
      return `[${event.containerName}] proxying loopback :${event.port} via ${event.listenHost}:${event.port}`
    case 'loopback-proxy-failed':
      return `[${event.containerName}] loopback proxy :${event.port} failed: ${event.reason}`
    case 'loopback-proxy-exited':
      return `[${event.containerName}] loopback proxy :${event.port} exited: ${event.reason}`
    case 'skip-eaddrinuse':
      return `[${event.containerName}] localhost:${event.port} unavailable: ${event.reason}`
    case 'ip-resolved':
      return `[${event.containerName}] container IP ${event.containerIp}`
    case 'ip-changed':
      return `[${event.containerName}] container IP ${event.from} -> ${event.to}`
    case 'detector-error':
      return `[${event.containerName}] detector: ${event.message}`
    case 'fatal':
      return `[${event.containerName}] fatal: ${event.message}`
  }
}
