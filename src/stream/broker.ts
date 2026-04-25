import type {
  Stream,
  StreamMessage,
  StreamMessageId,
  StreamMessageInput,
  SubscribeFilter,
  SubscribeListener,
  TargetFilter,
  Unsubscribe,
} from './types'
import { StreamTimeoutError } from './types'

type Subscription = {
  filter: SubscribeFilter
  listener: SubscribeListener
}

const DEFAULT_AWAIT_TIMEOUT_MS = 30_000

export function createStream(): Stream {
  const subscriptions = new Set<Subscription>()
  let counter = 0

  function generateId(): StreamMessageId {
    counter++
    return `s_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  function deliver(msg: StreamMessage): void {
    for (const sub of subscriptions) {
      if (!matchesFilter(sub.filter, msg)) continue
      try {
        const result = sub.listener(msg)
        if (result instanceof Promise) result.catch((err) => logListenerError(msg, err))
      } catch (err) {
        logListenerError(msg, err)
      }
    }
  }

  function publishMessage(input: StreamMessageInput): StreamMessage {
    const msg: StreamMessage = {
      id: generateId(),
      ts: Date.now(),
      target: input.target,
      payload: input.payload,
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    }
    deliver(msg)
    return msg
  }

  return {
    publish(input) {
      return publishMessage(input).id
    },

    publishAndAwait(input, opts) {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS
      return new Promise<StreamMessage>((resolve, reject) => {
        const requestId = generateId()
        const requestMessage: StreamMessage = {
          id: requestId,
          ts: Date.now(),
          target: input.target,
          payload: input.payload,
          ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
          ...(input.meta !== undefined ? { meta: input.meta } : {}),
        }

        const timer = setTimeout(() => {
          unsub()
          reject(new StreamTimeoutError(requestId, timeoutMs))
        }, timeoutMs)

        const subscription: Subscription = {
          filter: { replyTo: requestId },
          listener: (reply) => {
            clearTimeout(timer)
            unsub()
            resolve(reply)
          },
        }
        subscriptions.add(subscription)
        const unsub = () => subscriptions.delete(subscription)

        deliver(requestMessage)
      })
    },

    reply(toStreamMessageId, payload) {
      return publishMessage({
        target: { kind: 'broadcast' },
        payload,
        replyTo: toStreamMessageId,
      }).id
    },

    subscribe(filter, listener) {
      const subscription: Subscription = { filter, listener }
      subscriptions.add(subscription)
      const unsubscribe: Unsubscribe = () => {
        subscriptions.delete(subscription)
      }
      return unsubscribe
    },

    scan(filter) {
      void filter
      return []
    },
  }
}

function matchesFilter(filter: SubscribeFilter, msg: StreamMessage): boolean {
  if (filter.replyTo !== undefined && msg.replyTo !== filter.replyTo) return false
  if (filter.target !== undefined && !matchesTarget(filter.target, msg)) return false
  return true
}

function matchesTarget(filter: TargetFilter, msg: StreamMessage): boolean {
  if (filter.kind !== msg.target.kind) return false
  switch (filter.kind) {
    case 'broadcast':
      return true
    case 'session':
      return filter.sessionId === undefined || filter.sessionId === (msg.target as { sessionId: string }).sessionId
    case 'new-session':
      return filter.role === undefined || filter.role === (msg.target as { role?: string }).role
    case 'cron':
      return filter.jobId === undefined || filter.jobId === (msg.target as { jobId: string }).jobId
  }
}

function logListenerError(msg: StreamMessage, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[stream] subscriber error for message ${msg.id}: ${message}`)
}
