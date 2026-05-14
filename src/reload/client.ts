import type { ClientMessage, ServerMessage } from '@/shared'

import type { ReloadResult } from './types'

export type RequestReloadOptions = {
  url: string
  scope?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export async function requestReload({
  url,
  scope,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: RequestReloadOptions): Promise<ReloadResult[]> {
  const ws = new WebSocket(url)
  const displayUrl = redactUrl(url)

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (err: unknown) => {
      cleanup()
      reject(new Error(`failed to connect to ${displayUrl}: ${err instanceof Error ? err.message : String(err)}`))
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`connection to ${displayUrl} closed before opening`))
    }
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onClose)
    }
    timer = setTimeout(() => {
      cleanup()
      ws.close()
      reject(new Error(`timed out connecting to ${displayUrl} after ${timeoutMs}ms`))
    }, timeoutMs)
    ws.addEventListener('open', onOpen, { once: true })
    ws.addEventListener('error', onError, { once: true })
    ws.addEventListener('close', onClose, { once: true })
  })

  try {
    const request: ClientMessage = scope ? { type: 'reload', scope } : { type: 'reload' }
    ws.send(JSON.stringify(request))

    return await new Promise<ReloadResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMessage)
        reject(new Error(`timed out waiting for reload_result after ${timeoutMs}ms`))
      }, timeoutMs)

      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data)) as ServerMessage
        if (msg.type !== 'reload_result') return
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(msg.results)
      }
      ws.addEventListener('message', onMessage)
    })
  } finally {
    ws.close()
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
