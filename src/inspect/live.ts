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
}

export async function* streamLive(opts: StreamLiveOptions): AsyncGenerator<InspectEvent> {
  const WS = opts.WebSocketImpl ?? WebSocket
  const ws = new WS(opts.url)
  const buffer: InspectEvent[] = []
  let resolveNext: ((value: { event: InspectEvent | null; done: boolean }) => void) | null = null
  let closed = false
  let pendingError: string | null = null

  const accumulators = new Map<string, string>()
  const thinkingAccumulators = new Map<string, string>()

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
    if (msg.type === 'error') {
      opts.onError?.(msg.message)
      pendingError = msg.message
      closed = true
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

  const onOpen = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket connection failed')), { once: true })
  })
  ws.addEventListener('close', () => {
    closed = true
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

  try {
    await onOpen
  } catch (err) {
    closed = true
    throw err
  }

  const subscribe: InspectClientMessage = {
    type: 'subscribe',
    sessionId: opts.sessionId,
    ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
  }
  ws.send(JSON.stringify(subscribe))

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
      return { cat: 'error', ts, message: payload.errorMessage }
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
