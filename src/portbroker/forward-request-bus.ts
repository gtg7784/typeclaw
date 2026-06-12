// In-process event bus for explicit container→host forward requests. The
// agent-browser plugin runs in the same process as the container broker but
// does not hold a broker handle, so it publishes here and run/index wires the
// bus into createContainerBroker.

export type ForwardRequestEvent = {
  targetPort: number
  hostCandidates: number[]
  reason?: string
}

type Subscriber = (event: ForwardRequestEvent) => void

const subscribers = new Set<Subscriber>()

export function publishForwardRequest(event: ForwardRequestEvent): void {
  for (const sub of subscribers) {
    try {
      sub(event)
    } catch {
      // Subscriber failures must not block peer subscribers.
    }
  }
}

export function subscribeForwardRequest(cb: Subscriber): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function __resetForwardRequestBus(): void {
  subscribers.clear()
}
