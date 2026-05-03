import type { PortForward } from '@/config'
import { resolveHostPort } from '@/container'
import { type Broker, createBroker, type PortForwardEvent } from '@/portbroker'

import type { PortbrokerCallbacks, PortbrokerStartInput } from './daemon'

export type PortbrokerManagerOptions = {
  resolveHostPortFor?: (input: { containerName: string; cwd: string }) => Promise<number | null>
  onLog?: (msg: string) => void
}

// Glue between hostd's daemon and the portbroker package. Owns a Broker
// instance per registered containerName. The daemon calls start()/stop()
// through this manager. Reconnect after container restart works because the
// resolver is re-invoked on each connect attempt — see portbroker hostd-client.
export function createPortbrokerManager(opts: PortbrokerManagerOptions = {}): PortbrokerCallbacks & {
  drain: () => Promise<void>
} {
  const brokers = new Map<string, Broker>()
  const resolver = opts.resolveHostPortFor ?? defaultResolveHostPort
  const log = opts.onLog ?? (() => {})

  return {
    start(input: PortbrokerStartInput) {
      const existing = brokers.get(input.containerName)
      if (existing) {
        void existing.stop().catch(() => {})
      }
      const broker = createBroker({
        containerName: input.containerName,
        cwd: input.cwd,
        policy: input.policy,
        resolveHostPort: () => resolver({ containerName: input.containerName, cwd: input.cwd }),
        brokerToken: input.brokerToken,
        onEvent: input.onEvent,
        onLog: (msg) => log(`[portbroker:${input.containerName}] ${msg}`),
      })
      brokers.set(input.containerName, broker)
      broker.start()
    },

    async stop(containerName, reason) {
      const broker = brokers.get(containerName)
      if (!broker) return
      brokers.delete(containerName)
      await broker.stop()
      log(`[portbroker:${containerName}] stopped (${reason})`)
    },

    async drain() {
      const all = Array.from(brokers.values())
      brokers.clear()
      await Promise.allSettled(all.map((b) => b.stop()))
    },
  }
}

async function defaultResolveHostPort(input: { containerName: string; cwd: string }): Promise<number | null> {
  try {
    return await resolveHostPort({ cwd: input.cwd, retryMs: 500, intervalMs: 50 })
  } catch {
    return null
  }
}

export type { PortForward, PortForwardEvent }
