import { defineCommand } from 'citty'

import type { BrokerLogEvent } from '@/portbroker/broker'
import { startDaemon, type DaemonLogEvent } from '@/portbroker/daemon'

export const portbrokerdCommand = defineCommand({
  meta: {
    name: '_portbrokerd',
    description: 'internal: host-side TCP port broker daemon (do not invoke directly)',
    hidden: true,
  },
  async run() {
    const daemon = await startDaemon({
      onLog: (e) => console.log(formatLog(e)),
    })

    const shutdown = (): void => {
      void daemon.stop().then(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    await new Promise<void>(() => {})
  },
})

function formatLog(event: BrokerLogEvent | DaemonLogEvent): string {
  switch (event.kind) {
    case 'daemon-listening':
      return `[portbrokerd] listening on ${event.socket}`
    case 'daemon-stopping':
      return `[portbrokerd] stopping`
    case 'register':
      return `[portbrokerd] registered ${event.containerName}`
    case 'deregister':
      return `[portbrokerd] deregistered ${event.containerName} (${event.reason})`
    case 'open':
      return `[${event.containerName}] forwarding localhost:${event.hostPort} -> ${event.upstreamHost}:${event.upstreamPort}`
    case 'close':
      return `[${event.containerName}] released localhost:${event.hostPort}`
    case 'skip-excluded':
      return `[${event.containerName}] skipping :${event.port} (excluded)`
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
