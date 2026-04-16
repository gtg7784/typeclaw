import type { ClientMessage, ServerMessage } from '@/shared'

export type Client = Awaited<ReturnType<typeof createClient>>

export async function createClient(url: string) {
  const ws = new WebSocket(url)
  const listeners = new Set<(msg: ServerMessage) => void>()

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as ServerMessage
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
      return () => listeners.delete(fn)
    },
    onClose: (fn: () => void) => ws.addEventListener('close', fn),
    onError: (fn: (err: unknown) => void) => ws.addEventListener('error', fn),
    send: (msg: ClientMessage) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  }
}
