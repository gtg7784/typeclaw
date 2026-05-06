// In-process event bus for `port-forward-result` events emitted by the
// host-side broker over the WS to the container side. Lives as a module-level
// singleton so the run-loop wiring (src/run/index.ts) can publish events from
// the broker callback while consumers (e.g. the agent-browser plugin's
// bind-with-forward retry loop) subscribe by importing this module without
// needing a reference to the ContainerBroker itself.
//
// Tests should call `__resetForwardResultBus()` in afterEach so subscriptions
// from a previous test don't leak.

import type { ForwardResultEvent } from './container-server'

type Subscriber = (event: ForwardResultEvent) => void

const subscribers = new Set<Subscriber>()

export function publishForwardResult(event: ForwardResultEvent): void {
  for (const sub of subscribers) {
    try {
      sub(event)
    } catch {
      // Subscriber failures must not block the bus or affect peer subscribers.
    }
  }
}

export function subscribeForwardResult(cb: Subscriber): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function __resetForwardResultBus(): void {
  subscribers.clear()
}
