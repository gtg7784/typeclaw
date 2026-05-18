import { resolveHostPort, resolveTuiToken } from '@/container'
import type { ClientMessage, CronListEntryPayload, ServerMessage } from '@/shared'

export type CronListBridgeOptions = {
  cwd: string
  url?: string
  timeoutMs?: number
}

export type CronListBridgeResult =
  | { kind: 'ok'; jobs: CronListEntryPayload[]; nowMs: number }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'error'; reason: string }

const DEFAULT_TIMEOUT_MS = 15_000

export async function fetchCronList(opts: CronListBridgeOptions): Promise<CronListBridgeResult> {
  const reach = await dial(opts)
  if (reach.kind !== 'ok') return reach
  const { ws, timeoutMs } = reach
  const requestId = randomId()
  try {
    return await awaitReply(ws, timeoutMs, requestId)
  } finally {
    ws.close()
  }
}

type DialResult = { kind: 'ok'; ws: WebSocket; timeoutMs: number } | { kind: 'unreachable'; reason: string }

async function dial(opts: CronListBridgeOptions): Promise<DialResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let url = opts.url
  if (url === undefined) {
    try {
      const port = await resolveHostPort({ cwd: opts.cwd })
      const token = await resolveTuiToken({ cwd: opts.cwd })
      url = buildBridgeUrl(port, token)
    } catch (err) {
      return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
    }
  }
  const ws = new WebSocket(url)
  const displayUrl = redactUrl(url)
  try {
    await new Promise<void>((resolve, reject) => {
      // Mirrors the wedged-handshake timeout from src/doctor/plugin-bridge.ts.
      // Bun's WebSocket has no built-in connect timeout; a stuck Upgrade
      // never fires 'open' nor 'error', so `typeclaw cron list` would hang.
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
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
        reject(new Error(`failed to connect to ${displayUrl}: ${err instanceof Error ? err.message : String(err)}`))
      }
      const onClose = () => {
        cleanup()
        reject(new Error(`connection to ${displayUrl} closed before opening`))
      }
      timer = setTimeout(() => {
        cleanup()
        try {
          ws.close()
        } catch {}
        reject(new Error(`timed out connecting to ${displayUrl} after ${timeoutMs}ms`))
      }, timeoutMs)
      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onError, { once: true })
      ws.addEventListener('close', onClose, { once: true })
    })
  } catch (err) {
    return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
  }
  return { kind: 'ok', ws, timeoutMs }
}

async function awaitReply(ws: WebSocket, timeoutMs: number, requestId: string): Promise<CronListBridgeResult> {
  const outgoing: ClientMessage = { type: 'cron_list', requestId }
  ws.send(JSON.stringify(outgoing))
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    const onMessage = (event: MessageEvent) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage
      } catch (err) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve({ kind: 'error', reason: err instanceof Error ? err.message : String(err) })
        return
      }
      if (msg.type !== 'cron_list_result' || msg.requestId !== requestId) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      if (msg.result.ok) {
        resolve({ kind: 'ok', jobs: msg.result.jobs, nowMs: msg.result.nowMs })
      } else {
        resolve({ kind: 'error', reason: msg.result.reason })
      }
    }
    ws.addEventListener('message', onMessage)
  })
}

function buildBridgeUrl(port: number, token: string | null): string {
  const url = new URL(`ws://127.0.0.1:${port}`)
  if (token !== null) url.searchParams.set('token', token)
  return url.toString()
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

function randomId(): string {
  return `cron-${crypto.randomUUID()}`
}
