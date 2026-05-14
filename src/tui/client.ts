import type { ClientMessage, ServerMessage } from '@/shared'

export type Client = Awaited<ReturnType<typeof createClient>>

export type CreateClientOptions = {
  timeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export async function createClient(url: string, { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS }: CreateClientOptions = {}) {
  const ws = new WebSocket(url)
  const displayUrl = redactUrl(url)
  const listeners = new Set<(msg: ServerMessage) => void>()
  const closeListeners = new Set<() => void>()
  const errorListeners = new Set<(err: unknown) => void>()
  let closed = false
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
    closed = true
    listeners.clear()
    for (const fn of closeListeners) fn()
    closeListeners.clear()
  })

  ws.addEventListener('error', (err) => {
    for (const fn of errorListeners) fn(err)
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      ws.close()
      reject(new Error(`timed out connecting to ${displayUrl} after ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onClose)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (err: unknown) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`connection to ${displayUrl} closed before opening`))
    }
    ws.addEventListener('open', onOpen, { once: true })
    ws.addEventListener('error', onError, { once: true })
    ws.addEventListener('close', onClose, { once: true })
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
    onClose: (fn: () => void) => {
      if (closed) {
        queueMicrotask(fn)
        return () => {}
      }
      closeListeners.add(fn)
      return () => closeListeners.delete(fn)
    },
    onError: (fn: (err: unknown) => void) => {
      errorListeners.add(fn)
      return () => errorListeners.delete(fn)
    },
    send: (msg: ClientMessage) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '<redacted>')
    return parsed.toString()
  } catch {
    return url
  }
}
