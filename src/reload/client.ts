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

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (err: unknown) => {
      cleanup()
      reject(err instanceof Error ? err : new Error(`failed to connect to ${url}`))
    }
    const cleanup = () => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
    }
    ws.addEventListener('open', onOpen, { once: true })
    ws.addEventListener('error', onError, { once: true })
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
