import type { Unsubscribe } from '@/stream'

export const DEFAULT_LOG_RING_MAX_BYTES = 1024 * 1024

export type LogLineSubscriber = (line: string) => void

export type LogRingOptions = {
  maxBytes?: number
}

export type LogRing = {
  append: (line: string) => void
  snapshot: () => string[]
  subscribe: (cb: LogLineSubscriber) => Unsubscribe
}

const encoder = new TextEncoder()

export function createLogRing(options: LogRingOptions = {}): LogRing {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_RING_MAX_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('LogRing maxBytes must be a positive integer')
  }

  const lines: string[] = []
  const sizes: number[] = []
  const subscribers = new Set<LogLineSubscriber>()
  let bytes = 0

  return {
    append(line: string): void {
      const size = encoder.encode(line).byteLength
      lines.push(line)
      sizes.push(size)
      bytes += size

      while (bytes > maxBytes && lines.length > 1) {
        lines.shift()
        bytes -= sizes.shift() ?? 0
      }

      for (const subscriber of subscribers) subscriber(line)
    },
    snapshot(): string[] {
      return [...lines]
    },
    subscribe(cb: LogLineSubscriber): Unsubscribe {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
  }
}
