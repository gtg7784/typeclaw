import type { PortForward } from '@/config'
import { resolveHostPort } from '@/container'
import { type Broker, createBroker, type BrokerOptions, type PortForwardEvent } from '@/portbroker'

import type { PortbrokerCallbacks, PortbrokerStartInput } from './daemon'
import { createTailscaleServeManager, type TailscaleExec, type TailscaleServeManager } from './tailscale'

export type PortbrokerManagerOptions = {
  resolveHostPortFor?: (input: { containerName: string; cwd: string }) => Promise<number | null>
  onLog?: (msg: string) => void
  tailscaleExec?: TailscaleExec
  createBrokerFor?: (opts: BrokerOptions) => Broker
}

// Glue between hostd's daemon and the portbroker package. Owns a Broker
// instance per registered containerName. The daemon calls start()/stop()
// through this manager. Reconnect after container restart works because the
// resolver is re-invoked on each connect attempt — see portbroker hostd-client.
export function createPortbrokerManager(opts: PortbrokerManagerOptions = {}): PortbrokerCallbacks & {
  drain: () => Promise<void>
} {
  const brokers = new Map<string, Broker>()
  const tailscaleManagers = new Map<string, TailscaleServeManager>()
  const resolver = opts.resolveHostPortFor ?? defaultResolveHostPort
  const log = opts.onLog ?? (() => {})
  const brokerFactory = opts.createBrokerFor ?? createBroker

  return {
    // start() awaits the previous broker's stop before constructing the new
    // one. The fire-and-forget shape this replaced let a stale T_old broker
    // win the race to send broker-hello against a brand-new container that
    // expects T_new, producing a one-shot `auth-failed: token mismatch`
    // broadcast at every re-register that arrived while the old broker was
    // still mid-stop. The race window was narrow but reproducible across
    // hostd-respawn-after-ungraceful-death + typeclaw restart, because the
    // restored T_old broker is alive for the duration of the register RPC.
    // Awaiting collapses the window to zero — by the time the T_new broker's
    // first connect() fires, the T_old broker has set stopped=true, cleared
    // its reconnect timer, and closed its WS.
    async start(input: PortbrokerStartInput) {
      const existing = brokers.get(input.containerName)
      if (existing) {
        brokers.delete(input.containerName)
        try {
          await existing.stop()
        } catch {}
      }
      const existingTailscale = tailscaleManagers.get(input.containerName)
      if (existingTailscale) {
        tailscaleManagers.delete(input.containerName)
        try {
          await existingTailscale.stopAll()
        } catch {}
      }
      const tailscale = createTailscaleServeManager({
        containerName: input.containerName,
        exec: opts.tailscaleExec,
        onEvent: input.onTailscaleServeEvent,
        onLog: (msg) => log(`[tailscale:${input.containerName}] ${msg}`),
      })
      tailscaleManagers.set(input.containerName, tailscale)
      const broker = brokerFactory({
        containerName: input.containerName,
        cwd: input.cwd,
        policy: input.policy,
        resolveHostPort: () => resolver({ containerName: input.containerName, cwd: input.cwd }),
        brokerToken: input.brokerToken,
        onEvent: (event) => {
          input.onEvent(event)
          if (event.kind === 'port-forward-opened') tailscale.servePort(event.port)
          else if (event.kind === 'port-forward-closed') tailscale.stopPort(event.port)
        },
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
      const tailscale = tailscaleManagers.get(containerName)
      if (tailscale) {
        tailscaleManagers.delete(containerName)
        await tailscale.stopAll()
      }
      log(`[portbroker:${containerName}] stopped (${reason})`)
    },

    forwardedPorts(containerName) {
      const broker = brokers.get(containerName)
      if (!broker) return []
      return broker.forwardedPorts()
    },

    async drain() {
      const all = Array.from(brokers.values())
      const tailscale = Array.from(tailscaleManagers.values())
      brokers.clear()
      tailscaleManagers.clear()
      await Promise.allSettled(all.map((b) => b.stop()))
      await Promise.allSettled(tailscale.map((t) => t.stopAll()))
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
