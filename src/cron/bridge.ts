import { CONTAINER_PORT, resolveHostPort, resolveTuiToken } from '@/container'
import type { ClientMessage, CronListEntryPayload, ServerMessage } from '@/shared'

export type CronListBridgeOptions = {
  cwd: string
  url?: string
  timeoutMs?: number
  // Injected for tests so the in-container short-circuit can be exercised
  // without polluting process.env. Production callers omit this and the
  // bridge reads from process.env directly.
  env?: NodeJS.ProcessEnv
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
      url = resolveInContainerUrl(opts.env ?? process.env) ?? (await resolveHostUrl(opts.cwd))
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

// In-container short-circuit: when typeclaw runs `docker run`, it sets
// TYPECLAW_CONTAINER_NAME (always) and TYPECLAW_TUI_TOKEN (when configured).
// Inside the container, docker is not on $PATH, so the host-side discovery
// path (resolveHostPort/resolveTuiToken — both shell out to `docker`) fails
// with "docker: command not found". We don't need docker here: the agent's
// WS server is listening on CONTAINER_PORT on the container's loopback, and
// the token is already in our env. Skip docker entirely and dial directly.
export function resolveInContainerUrl(env: NodeJS.ProcessEnv): string | null {
  if (env.TYPECLAW_CONTAINER_NAME === undefined) return null
  const token = env.TYPECLAW_TUI_TOKEN ?? ''
  return buildBridgeUrl(CONTAINER_PORT, token !== '' ? token : null)
}

async function resolveHostUrl(cwd: string): Promise<string> {
  const port = await resolveHostPort({ cwd })
  const token = await resolveTuiToken({ cwd })
  return buildBridgeUrl(port, token)
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
