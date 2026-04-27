import type { Stream, Unsubscribe } from '@/stream'

export type SubagentSpawner = (payload: unknown, subagent: string) => Promise<void>

export type SubagentConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateSubagentConsumerOptions = {
  stream: Stream
  spawners: Record<string, SubagentSpawner>
  inFlightKey?: (subagent: string, payload: unknown) => string
  logger?: SubagentConsumerLogger
}

export type SubagentConsumer = {
  start: () => void
  stop: () => void
  inFlightCount: () => number
}

const consoleLogger: SubagentConsumerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createSubagentConsumer({
  stream,
  spawners,
  inFlightKey = (subagent) => subagent,
  logger = consoleLogger,
}: CreateSubagentConsumerOptions): SubagentConsumer {
  const inFlight = new Set<string>()
  let unsubscribe: Unsubscribe | null = null

  return {
    start() {
      if (unsubscribe !== null) return
      unsubscribe = stream.subscribe({ target: { kind: 'new-session' } }, async (msg) => {
        const target = msg.target as { kind: 'new-session'; subagent?: string }
        const subagent = target.subagent
        if (subagent === undefined) {
          logger.warn(`[subagent-consumer] message ${msg.id} has no subagent field, ignoring`)
          return
        }
        const spawner = spawners[subagent]
        if (spawner === undefined) {
          logger.warn(`[subagent-consumer] no spawner registered for subagent '${subagent}', ignoring ${msg.id}`)
          return
        }
        const key = inFlightKey(subagent, msg.payload)
        if (inFlight.has(key)) {
          logger.warn(`[subagent] ${key}: previous run still in progress, skipping`)
          return
        }
        inFlight.add(key)
        try {
          await spawner(msg.payload, subagent)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`[subagent] ${key} failed: ${message}`)
        } finally {
          inFlight.delete(key)
        }
      })
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
    inFlightCount() {
      return inFlight.size
    },
  }
}
