import type { InspectClientMessage, InspectFramePayload, InspectServerMessage } from '@/shared'

import type { InspectEvent } from './types'

export type StreamLiveOptions = {
  url: string
  sessionId: string
  sinceMs?: number
  signal?: AbortSignal
  WebSocketImpl?: typeof WebSocket
  onSubscribed?: (live: boolean) => void
  onError?: (message: string) => void
  connectTimeoutMs?: number
  heartbeatIntervalMs?: number
  pongTimeoutMs?: number
  bufferedAmountCeiling?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_PONG_TIMEOUT_MS = 30_000
const DEFAULT_BUFFERED_AMOUNT_CEILING = 1_048_576

export async function* streamLive(opts: StreamLiveOptions): AsyncGenerator<InspectEvent> {
  const WS = opts.WebSocketImpl ?? WebSocket
  const ws = new WS(opts.url)
  const buffer: InspectEvent[] = []
  let resolveNext: ((value: { event: InspectEvent | null; done: boolean }) => void) | null = null
  let closed = false
  let pendingError: string | null = null

  const accumulators = new Map<string, string>()
  const thinkingAccumulators = new Map<string, string>()

  let heartbeat: ReturnType<typeof setInterval> | null = null
  let awaitingPongSince: number | null = null

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  const wake = (): void => {
    if (resolveNext !== null) {
      const fn = resolveNext
      resolveNext = null
      const next = buffer.shift() ?? null
      fn({ event: next, done: closed && buffer.length === 0 && next === null })
    }
  }

  ws.addEventListener('message', (e) => {
    let msg: InspectServerMessage
    try {
      msg = JSON.parse(String((e as MessageEvent).data)) as InspectServerMessage
    } catch {
      return
    }
    if (msg.type === 'subscribed') {
      opts.onSubscribed?.(msg.sessionLive)
      return
    }
    if (msg.type === 'pong') {
      awaitingPongSince = null
      return
    }
    if (msg.type === 'error') {
      opts.onError?.(msg.message)
      pendingError = msg.message
      closed = true
      stopHeartbeat()
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      wake()
      return
    }
    if (msg.type !== 'frame') return
    const event = frameToEvent(msg.payload, msg.ts, accumulators, thinkingAccumulators)
    if (event !== null) {
      buffer.push(event)
      wake()
    }
  })

  // Settle on open OR on any terminal condition (error/close/abort/timeout).
  // Resolving false on abort/close/timeout is what unblocks the connect gate —
  // otherwise `await onOpen` would hang forever and freeze the inspect CLI. The
  // timeout bounds Bun/websocket states that neither open nor error promptly.
  let connectTimer: ReturnType<typeof setTimeout> | null = null
  const onOpen = new Promise<boolean>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(true), { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket connection failed')), { once: true })
    ws.addEventListener('close', () => resolve(false), { once: true })
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) resolve(false)
      else opts.signal.addEventListener('abort', () => resolve(false), { once: true })
    }
    const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    connectTimer = setTimeout(() => reject(new Error('websocket connect timed out')), timeoutMs)
  })
  ws.addEventListener('close', () => {
    closed = true
    stopHeartbeat()
    wake()
  })

  if (opts.signal !== undefined) {
    if (opts.signal.aborted) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    } else {
      opts.signal.addEventListener(
        'abort',
        () => {
          closed = true
          stopHeartbeat()
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          wake()
        },
        { once: true },
      )
    }
  }

  let opened: boolean
  try {
    opened = await onOpen
  } catch (err) {
    closed = true
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    if (connectTimer !== null) clearTimeout(connectTimer)
  }
  if (!opened || closed || opts.signal?.aborted === true) return

  const subscribe: InspectClientMessage = {
    type: 'subscribe',
    sessionId: opts.sessionId,
    ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
  }
  ws.send(JSON.stringify(subscribe))

  startHeartbeat({
    ws,
    intervalMs: opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs: opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS,
    bufferedAmountCeiling: opts.bufferedAmountCeiling ?? DEFAULT_BUFFERED_AMOUNT_CEILING,
    isAwaitingPongSince: () => awaitingPongSince,
    setAwaitingPongSince: (at) => {
      awaitingPongSince = at
    },
    setTimer: (timer) => {
      heartbeat = timer
    },
    onDead: () => {
      closed = true
      stopHeartbeat()
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      wake()
    },
  })

  try {
    while (true) {
      if (buffer.length > 0) {
        const next = buffer.shift()!
        yield next
        continue
      }
      if (closed) {
        if (pendingError !== null) throw new Error(pendingError)
        return
      }
      const { event, done } = await new Promise<{ event: InspectEvent | null; done: boolean }>((resolve) => {
        resolveNext = resolve
      })
      if (event !== null) yield event
      if (done) {
        if (pendingError !== null) throw new Error(pendingError)
        return
      }
    }
  } finally {
    // Also fired when the consumer abandons the generator (break from a
    // `for await` calls .return()): close the socket so it can't outlive the
    // viewer, not just the heartbeat timer.
    stopHeartbeat()
    closed = true
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
}

type HeartbeatOptions = {
  ws: WebSocket
  intervalMs: number
  pongTimeoutMs: number
  bufferedAmountCeiling: number
  isAwaitingPongSince: () => number | null
  setAwaitingPongSince: (at: number | null) => void
  setTimer: (timer: ReturnType<typeof setInterval>) => void
  onDead: () => void
}

// Steady-state liveness watchdog. The connect gate only bounds the OPENING
// phase; once subscribed, a wedged socket (send queue not draining, no
// 'close'/'error') would park the read loop forever. The interval fires on the
// event-loop timer queue independent of the dead socket, so it always runs.
// Two independent death signals, both treated as a clean close (return, never
// throw) so the viewer recovers to the picker:
//   1. bufferedAmount past a ceiling — our writes are not draining.
//   2. a ping with no pong within the deadline — round-trip liveness lost,
//      which also covers idle tails (a quiet-but-healthy tail still pongs).
function startHeartbeat(opts: HeartbeatOptions): void {
  let pingId = 0
  const tick = (): void => {
    if (opts.ws.bufferedAmount >= opts.bufferedAmountCeiling) {
      opts.onDead()
      return
    }
    const awaiting = opts.isAwaitingPongSince()
    if (awaiting !== null) {
      if (Date.now() - awaiting >= opts.pongTimeoutMs) opts.onDead()
      return
    }
    pingId += 1
    const ping: InspectClientMessage = { type: 'ping', id: pingId }
    try {
      opts.ws.send(JSON.stringify(ping))
      opts.setAwaitingPongSince(Date.now())
    } catch {
      opts.onDead()
    }
  }
  opts.setTimer(setInterval(tick, opts.intervalMs))
}

function frameToEvent(
  payload: InspectFramePayload,
  ts: number,
  accumulators: Map<string, string>,
  thinkingAccumulators: Map<string, string>,
): InspectEvent | null {
  switch (payload.kind) {
    case 'text_delta': {
      const existing = accumulators.get(payload.sessionId) ?? ''
      accumulators.set(payload.sessionId, existing + payload.delta)
      return null
    }
    case 'thinking_delta': {
      const existing = thinkingAccumulators.get(payload.sessionId) ?? ''
      thinkingAccumulators.set(payload.sessionId, existing + payload.delta)
      return null
    }
    case 'thinking_end': {
      const accumulated = thinkingAccumulators.get(payload.sessionId) ?? ''
      thinkingAccumulators.delete(payload.sessionId)
      const text = accumulated !== '' ? accumulated : payload.text
      if (text === '' && payload.redacted !== true) return null
      return { cat: 'thinking', ts, text, ...(payload.redacted === true ? { redacted: true } : {}) }
    }
    case 'tool_start':
      return {
        cat: 'tool',
        ts,
        phase: 'start',
        toolCallId: payload.toolCallId,
        name: payload.name,
        ...(payload.args !== undefined ? { args: payload.args } : {}),
      }
    case 'tool_end':
      return {
        cat: 'tool',
        ts,
        phase: 'end',
        toolCallId: payload.toolCallId,
        name: payload.name,
        ...(payload.result !== undefined ? { result: payload.result } : {}),
        isError: payload.isError,
        durationMs: payload.durationMs,
      }
    case 'message_end':
      return messageEndToEvents(payload, ts, accumulators)
    case 'broadcast':
      return {
        cat: 'broadcast',
        ts,
        payload: payload.payload,
        ...(payload.meta !== undefined ? { meta: payload.meta } : {}),
      }
    case 'cron-fire':
      return { cat: 'cron-fire', ts, jobId: payload.jobId, payload: payload.payload }
    case 'channel_inbound':
      return {
        cat: 'inbound',
        ts: payload.ts > 0 ? payload.ts : ts,
        adapter: payload.adapter,
        workspace: payload.workspace,
        chat: payload.chat,
        thread: payload.thread,
        authorId: payload.authorId,
        authorName: payload.authorName,
        authorIsBot: payload.authorIsBot,
        isDm: payload.isDm,
        isBotMention: payload.isBotMention,
        text: payload.text,
        externalMessageId: payload.externalMessageId,
        decision: payload.decision,
      }
    default:
      return null
  }
}

function messageEndToEvents(
  payload: Extract<InspectFramePayload, { kind: 'message_end' }>,
  ts: number,
  accumulators: Map<string, string>,
): InspectEvent | null {
  if (payload.role === 'assistant') {
    const text = takeAccumulator(accumulators, payload.sessionId)
    if (text !== null && text !== '') {
      const event: InspectEvent = {
        cat: 'assistant',
        ts,
        text,
        ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
      }
      if (payload.errorMessage !== undefined) {
        return event
      }
      return event
    }
    if (payload.errorMessage !== undefined) {
      return {
        cat: 'error',
        ts,
        message: payload.errorMessage,
        ...(payload.stopReason !== undefined ? { stopReason: payload.stopReason } : {}),
      }
    }
    if (payload.usage !== undefined && (payload.usage.totalTokens > 0 || payload.stopReason !== undefined)) {
      return {
        cat: 'done',
        ts,
        ...(payload.stopReason !== undefined ? { stopReason: payload.stopReason } : {}),
        ...payload.usage,
      }
    }
    return null
  }
  return null
}

function takeAccumulator(accumulators: Map<string, string>, sessionId: string): string | null {
  const value = accumulators.get(sessionId)
  if (value === undefined) return null
  accumulators.delete(sessionId)
  return value
}
