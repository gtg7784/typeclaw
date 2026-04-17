import type { ClientMessage, ServerMessage } from '@/shared'

export type Client = Awaited<ReturnType<typeof createClient>>

export async function createClient(url: string) {
  const ws = new WebSocket(url)
  const listeners = new Set<(msg: ServerMessage) => void>()
  // Buffer messages that arrive before any listener is registered. In-process
  // connections (typeclaw run's local tui) deliver the first server frame
  // before the caller has a chance to attach onMessage.
  const pending: ServerMessage[] = []

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as ServerMessage
    if (listeners.size === 0) {
      pending.push(msg)
      return
    }
    for (const fn of listeners) fn(msg)
  })

  ws.addEventListener('close', () => {
    listeners.clear()
  })

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (err) => reject(err), { once: true })
  })

  return {
    onMessage: (fn: (msg: ServerMessage) => void) => {
      listeners.add(fn)
      if (pending.length > 0) {
        const buffered = pending.splice(0)
        for (const msg of buffered) fn(msg)
      }
      return () => listeners.delete(fn)
    },
    onClose: (fn: () => void) => ws.addEventListener('close', fn),
    onError: (fn: (err: unknown) => void) => ws.addEventListener('error', fn),
    send: (msg: ClientMessage) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  }
}
