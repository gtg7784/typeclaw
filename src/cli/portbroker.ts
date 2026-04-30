import { defineCommand } from 'citty'

import { loadConfigSync } from '@/config'
import { startBroker, type BrokerLogEvent } from '@/portbroker'

export const portbrokerCommand = defineCommand({
  meta: {
    name: '_portbroker',
    description: 'internal: host-side TCP port broker (do not invoke directly)',
  },
  args: {
    container: { type: 'string', required: true },
    cwd: { type: 'string', required: true },
  },
  async run({ args }) {
    const cfg = loadConfigSync(args.cwd)
    if (!cfg.autoForward) {
      console.log('autoForward disabled in typeclaw.json; broker exiting')
      return
    }

    const exclude = new Set<number>([cfg.port, ...cfg.autoForwardExclude])

    const result = await startBroker({
      containerName: args.container,
      excludePorts: exclude,
      onLog: formatLog,
    })
    if (!result.ok) {
      console.error(`[portbroker] ${result.reason}`)
      process.exit(1)
    }

    const stop = (signal: NodeJS.Signals): void => {
      result.broker.stop().finally(() => process.exit(signal === 'SIGTERM' ? 0 : 0))
    }
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGINT', () => stop('SIGINT'))

    await new Promise<void>(() => {})
  },
})

function formatLog(event: BrokerLogEvent): void {
  switch (event.kind) {
    case 'open':
      console.log(`[portbroker] forwarding localhost:${event.hostPort} -> ${event.upstreamHost}:${event.upstreamPort}`)
      return
    case 'close':
      console.log(`[portbroker] released localhost:${event.hostPort}`)
      return
    case 'skip-excluded':
      console.log(`[portbroker] skipping :${event.port} (excluded)`)
      return
    case 'skip-eaddrinuse':
      console.log(`[portbroker] localhost:${event.port} in use; not forwarding (${event.reason})`)
      return
    case 'ip-resolved':
      console.log(`[portbroker] container IP ${event.containerIp}`)
      return
    case 'ip-changed':
      console.log(`[portbroker] container IP changed ${event.from} -> ${event.to}`)
      return
    case 'detector-error':
      console.error(`[portbroker] detector: ${event.message}`)
      return
    case 'fatal':
      console.error(`[portbroker] fatal: ${event.message}`)
      return
  }
}
