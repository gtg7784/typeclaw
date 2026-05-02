import { defineCommand } from 'citty'

import { loadConfigSync, validateConfig } from '@/config'
import { start, stop } from '@/container'
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
    const cliEntry = process.argv[1] ?? ''
    const srcRoot = resolveSrcRoot(cliEntry)
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
          cliEntry,
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

function formatLog(event: DaemonLogEvent | SupervisorLogEvent): string {
  switch (event.kind) {
    case 'daemon-listening':
      return `[hostd] listening on ${event.socket}`
    case 'daemon-http-listening':
      return `[hostd] HTTP control listening on ${event.host}:${event.port}`
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
  }
}
