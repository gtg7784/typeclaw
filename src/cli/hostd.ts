import { defineCommand } from 'citty'

import type { BrokerLogEvent } from '@/hostd'
import { startDaemon, type DaemonLogEvent } from '@/hostd/daemon'

export const hostdCommand = defineCommand({
  meta: {
    name: '_hostd',
    description: 'internal: host-side typeclaw daemon (do not invoke directly)',
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
      return `[hostd] listening on ${event.socket}`
    case 'daemon-stopping':
      return `[hostd] stopping`
    case 'register':
      return `[hostd] registered ${event.containerName}`
    case 'deregister':
      return `[hostd] deregistered ${event.containerName} (${event.reason})`
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
