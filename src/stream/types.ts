export type StreamMessageId = string

export type StreamTarget =
  | { kind: 'broadcast' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'new-session'; role?: string }
  | { kind: 'cron'; jobId: string }

export type StreamMessage = {
  id: StreamMessageId
  ts: number
  target: StreamTarget
  payload: unknown
  replyTo?: StreamMessageId
  meta?: Record<string, string>
}

export type StreamMessageInput = {
  target: StreamTarget
  payload: unknown
  replyTo?: StreamMessageId
  meta?: Record<string, string>
}

export type SubscribeFilter = {
  target?: TargetFilter
  replyTo?: StreamMessageId
}

export type ScanFilter = SubscribeFilter & {
  sinceTs?: number
  limit?: number
}

export type TargetFilter =
  | { kind: 'broadcast' }
  | { kind: 'session'; sessionId?: string }
  | { kind: 'new-session'; role?: string }
  | { kind: 'cron'; jobId?: string }

export type Unsubscribe = () => void

export type SubscribeListener = (msg: StreamMessage) => unknown

export type PublishAndAwaitOptions = {
  timeoutMs?: number
}

export type Stream = {
  publish(message: StreamMessageInput): StreamMessageId
  publishAndAwait(message: StreamMessageInput, opts?: PublishAndAwaitOptions): Promise<StreamMessage>
  reply(toStreamMessageId: StreamMessageId, payload: unknown): StreamMessageId
  subscribe(filter: SubscribeFilter, onMessage: SubscribeListener): Unsubscribe
  scan(filter?: ScanFilter): StreamMessage[]
}

export type CreateStreamOptions = {
  historySize?: number
}

export class StreamTimeoutError extends Error {
  constructor(
    public readonly requestId: StreamMessageId,
    public readonly timeoutMs: number,
  ) {
    super(`stream: timed out after ${timeoutMs}ms waiting for reply to ${requestId}`)
    this.name = 'StreamTimeoutError'
  }
}
