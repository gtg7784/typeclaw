import type {
  ClaimCompletedPayload,
  ClaimErrorPayload,
  ClaimStartedPayload,
  ClientMessage,
  ServerMessage,
} from '@/shared'

import { generateClaimCode } from './code'

export type ClaimSessionOptions = {
  url: string
  role: string
  channel?: string
  ttlMs?: number
  connectTimeoutMs?: number
  onStarted?: (payload: ClaimStartedPayload) => void
}

export type ClaimSessionResult =
  | { kind: 'completed'; payload: ClaimCompletedPayload }
  | { kind: 'error'; payload: ClaimErrorPayload }
  | { kind: 'timeout' }

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export async function runClaimSession(opts: ClaimSessionOptions): Promise<ClaimSessionResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const code = generateClaimCode()

  const ws = new WebSocket(opts.url)
  const displayUrl = redactUrl(opts.url)
  await waitForOpen(ws, displayUrl, connectTimeoutMs)
  await waitForConnected(ws, displayUrl, connectTimeoutMs)

  try {
    const request: ClientMessage = {
      type: 'claim_start',
      code,
      role: opts.role,
      ttlMs,
      ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
    }
    ws.send(JSON.stringify(request))

    return await waitForOutcome(ws, code, ttlMs, opts.onStarted)
  } finally {
    try {
      const cancel: ClientMessage = { type: 'claim_cancel' }
      ws.send(JSON.stringify(cancel))
    } catch {}
    ws.close()
  }
}

async function waitForOpen(ws: WebSocket, displayUrl: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      ws.close()
      reject(new Error(`timed out connecting to ${displayUrl} after ${timeoutMs}ms`))
    }, timeoutMs)
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
      clearTimeout(timer)
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onClose)
    }
    ws.addEventListener('open', onOpen, { once: true })
    ws.addEventListener('error', onError, { once: true })
    ws.addEventListener('close', onClose, { once: true })
  })
}

// The server's WS `open` handler is async (it awaits createSession) and only
// registers per-ws state and sends `connected` after that resolves. Bun
// delivers any client messages received before `open` completes, but the
// server's `claim_start` handler silently drops messages when state is null.
// Waiting here mirrors what the TUI client does (see src/tui/index.ts) and
// fixes the hatching-time hang where the spinner stayed on "Generating your
// claim code..." until the ttl expired.
async function waitForConnected(ws: WebSocket, displayUrl: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      ws.close()
      reject(new Error(`timed out waiting for connected message from ${displayUrl} after ${timeoutMs}ms`))
    }, timeoutMs)
    const onMessage = (event: MessageEvent): void => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage
      } catch {
        return
      }
      if (msg.type === 'connected') {
        cleanup()
        resolve()
        return
      }
      if (msg.type === 'error') {
        cleanup()
        reject(new Error(`server rejected connection to ${displayUrl}: ${msg.message}`))
      }
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`connection to ${displayUrl} closed before the session was ready`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
    }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose, { once: true })
  })
}

async function waitForOutcome(
  ws: WebSocket,
  code: string,
  ttlMs: number,
  onStarted?: (payload: ClaimStartedPayload) => void,
): Promise<ClaimSessionResult> {
  return new Promise<ClaimSessionResult>((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      resolve({ kind: 'timeout' })
    }, ttlMs + 5_000)

    const onMessage = (event: MessageEvent): void => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage
      } catch {
        return
      }
      if (msg.type === 'claim_started' && msg.payload.code === code) {
        onStarted?.(msg.payload)
        return
      }
      if (msg.type === 'claim_completed' && msg.payload.code === code) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve({ kind: 'completed', payload: msg.payload })
        return
      }
      if (msg.type === 'claim_error' && msg.payload.code === code) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve({ kind: 'error', payload: msg.payload })
        return
      }
    }
    ws.addEventListener('message', onMessage)
  })
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
