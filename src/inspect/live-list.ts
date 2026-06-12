import type { InspectClientMessage, InspectServerMessage, LiveSessionPayload } from '@/shared'

export type FetchLiveSessionsOptions = {
  url: string
  signal?: AbortSignal
  WebSocketImpl?: typeof WebSocket
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000

// One-shot query of the container's in-memory session registry over the
// /inspect WS: open, send list_live, read the single reply, close. Failure
// (container down, timeout, abort) resolves to [] so the picker degrades to the
// disk-only listing rather than erroring — the live overlay is best-effort.
export async function fetchLiveSessions(opts: FetchLiveSessionsOptions): Promise<LiveSessionPayload[]> {
  const WS = opts.WebSocketImpl ?? WebSocket
  if (opts.signal?.aborted === true) return []

  return new Promise<LiveSessionPayload[]>((resolve) => {
    let settled = false
    const ws = new WS(opts.url)

    const finish = (result: LiveSessionPayload[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }

    const timer = setTimeout(() => finish([]), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    if (opts.signal !== undefined) {
      opts.signal.addEventListener('abort', () => finish([]), { once: true })
    }

    ws.addEventListener('open', () => {
      const req: InspectClientMessage = { type: 'list_live' }
      try {
        ws.send(JSON.stringify(req))
      } catch {
        finish([])
      }
    })

    ws.addEventListener('message', (e) => {
      let msg: InspectServerMessage
      try {
        msg = JSON.parse(String((e as MessageEvent).data)) as InspectServerMessage
      } catch {
        return
      }
      if (msg.type === 'live_sessions') finish(msg.sessions)
      else if (msg.type === 'error') finish([])
    })

    ws.addEventListener('error', () => finish([]))
    ws.addEventListener('close', () => finish([]))
  })
}
