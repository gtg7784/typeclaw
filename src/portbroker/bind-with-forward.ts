// Allocate an in-container port whose host-side forward succeeds.
//
// In-container LISTEN succeeds even when the host-side forward collides with
// another container — each container has its own netns, so the procfs check
// can't tell us anything about host-side availability. This helper closes
// that gap: it calls a factory to bind a candidate port internally, waits
// for the broker's `port-forward-result` event, and on failure tears the
// candidate down and tries the next port. Used today by the agent-browser
// plugin's dashboard proxy bind, where multiple typeclaw containers on one
// host all want port 4848 externally and only the first to register wins.
//
// Returns the bound result on first success, or null after exhausting the
// candidate list. Callers MUST treat null as "give up, no host-reachable
// port available" — there is no further recourse without operator action
// (e.g. stopping the colliding container).
//
// If the broker isn't reachable (no TYPECLAW_HOSTD_BROKER_TOKEN, broker
// disconnected, etc.) the bus never receives results. The helper falls
// through to optimistic mode: the first successful in-container bind is
// returned without waiting, on the assumption that no broker means no
// host-side cross-container collision is possible.

import { subscribeForwardResult } from './forward-result-bus'

export type BindResult<T> = {
  port: number
  hostPort: number | null
  resource: T
}

export type BindFactory<T> = (port: number) => Promise<{ resource: T; close: () => void } | null>

export type BindWithForwardOptions<T> = {
  candidates: number[]
  factory: BindFactory<T>
  timeoutMs?: number
  brokerEnabled?: boolean
  onLog?: (msg: string) => void
}

const DEFAULT_TIMEOUT_MS = 2_000

export async function bindWithForward<T>(opts: BindWithForwardOptions<T>): Promise<BindResult<T> | null> {
  const log = opts.onLog ?? (() => {})
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const brokerEnabled = opts.brokerEnabled ?? defaultBrokerEnabled()

  for (const port of opts.candidates) {
    const bound = await opts.factory(port)
    if (bound === null) {
      log(`bind ${port}: factory returned null (in-container bind failed); trying next`)
      continue
    }

    if (!brokerEnabled) {
      log(`bind ${port}: broker disabled; returning optimistically`)
      return { port, hostPort: null, resource: bound.resource }
    }

    const forward = await waitForForwardResult(port, timeoutMs)
    if (forward.kind === 'ok') {
      log(`bind ${port}: forwarded to host:${forward.hostPort}`)
      return { port, hostPort: forward.hostPort, resource: bound.resource }
    }

    log(`bind ${port}: forward ${forward.kind === 'failed' ? `failed (${forward.reason})` : 'timed out'}; tearing down`)
    try {
      bound.close()
    } catch {
      // Close failures are non-fatal here; the next factory call may pick a
      // different port and the orphaned listener will be reaped on process
      // exit. Logging would just be noise.
    }
  }
  return null
}

type WaitResult = { kind: 'ok'; hostPort: number } | { kind: 'failed'; reason: string } | { kind: 'timeout' }

function waitForForwardResult(port: number, timeoutMs: number): Promise<WaitResult> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      unsubscribe()
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    const unsubscribe = subscribeForwardResult((event) => {
      if (event.port !== port || settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(event.ok ? { kind: 'ok', hostPort: event.hostPort } : { kind: 'failed', reason: event.reason })
    })
  })
}

function defaultBrokerEnabled(): boolean {
  const token = process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
  return token !== undefined && token.length > 0
}
