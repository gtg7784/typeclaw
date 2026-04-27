import { describe, expect, test } from 'bun:test'

import { createStream } from '@/stream'

import { createSubagentConsumer, type SubagentConsumerLogger, type SubagentSpawner } from './consumer'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function silentLogger(): SubagentConsumerLogger & { warns: string[]; errors: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  return {
    info: () => {},
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    warns,
    errors,
  }
}

describe('createSubagentConsumer', () => {
  test('dispatches new-session messages to the spawner registered for that subagent', async () => {
    const stream = createStream()
    const calls: Array<{ payload: unknown; subagent: string }> = []
    const spawner: SubagentSpawner = async (payload, subagent) => {
      calls.push({ payload, subagent })
    }

    const consumer = createSubagentConsumer({
      stream,
      spawners: { 'memory-logger': spawner },
      logger: silentLogger(),
    })
    consumer.start()

    stream.publish({ target: { kind: 'new-session', subagent: 'memory-logger' }, payload: { hello: 'world' } })

    await sleep(0)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ payload: { hello: 'world' }, subagent: 'memory-logger' })
    consumer.stop()
  })

  test('coalesces concurrent messages with the same in-flight key', async () => {
    const stream = createStream()
    let inProgress = 0
    let maxConcurrent = 0
    const spawner: SubagentSpawner = async () => {
      inProgress++
      maxConcurrent = Math.max(maxConcurrent, inProgress)
      await sleep(20)
      inProgress--
    }

    const consumer = createSubagentConsumer({
      stream,
      spawners: { 'memory-logger': spawner },
      logger: silentLogger(),
    })
    consumer.start()

    stream.publish({ target: { kind: 'new-session', subagent: 'memory-logger' }, payload: { id: 1 } })
    stream.publish({ target: { kind: 'new-session', subagent: 'memory-logger' }, payload: { id: 2 } })
    stream.publish({ target: { kind: 'new-session', subagent: 'memory-logger' }, payload: { id: 3 } })

    await sleep(50)

    expect(maxConcurrent).toBe(1)
    consumer.stop()
  })

  test('does not coalesce when inFlightKey differentiates messages', async () => {
    const stream = createStream()
    let inProgress = 0
    let maxConcurrent = 0
    const spawner: SubagentSpawner = async () => {
      inProgress++
      maxConcurrent = Math.max(maxConcurrent, inProgress)
      await sleep(20)
      inProgress--
    }

    const consumer = createSubagentConsumer({
      stream,
      spawners: { 'memory-logger': spawner },
      inFlightKey: (subagent, payload) => `${subagent}:${(payload as { parentSessionId: string }).parentSessionId}`,
      logger: silentLogger(),
    })
    consumer.start()

    stream.publish({
      target: { kind: 'new-session', subagent: 'memory-logger' },
      payload: { parentSessionId: 'A' },
    })
    stream.publish({
      target: { kind: 'new-session', subagent: 'memory-logger' },
      payload: { parentSessionId: 'B' },
    })

    await sleep(50)

    expect(maxConcurrent).toBe(2)
    consumer.stop()
  })

  test('different subagents do not coalesce against each other (default key = subagent)', async () => {
    const stream = createStream()
    const calls: string[] = []
    const slowSpawner: SubagentSpawner = async (_payload, subagent) => {
      await sleep(30)
      calls.push(subagent)
    }
    const fastSpawner: SubagentSpawner = async (_payload, subagent) => {
      calls.push(subagent)
    }

    const consumer = createSubagentConsumer({
      stream,
      spawners: { slow: slowSpawner, fast: fastSpawner },
      logger: silentLogger(),
    })
    consumer.start()

    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: null })
    stream.publish({ target: { kind: 'new-session', subagent: 'fast' }, payload: null })

    await sleep(60)

    expect(calls).toEqual(['fast', 'slow'])
    consumer.stop()
  })

  test('releases in-flight key after the spawner throws', async () => {
    const stream = createStream()
    let calls = 0
    const spawner: SubagentSpawner = async () => {
      calls++
      throw new Error('boom')
    }
    const logger = silentLogger()

    const consumer = createSubagentConsumer({
      stream,
      spawners: { 'memory-logger': spawner },
      logger,
    })
    consumer.start()

    stream.publish({ target: { kind: 'new-session', subagent: 'memory-logger' }, payload: { id: 1 } })
    await sleep(10)

    stream.publish({ target: { kind: 'new-session', subagent: 'memory-logger' }, payload: { id: 2 } })
    await sleep(10)

    expect(calls).toBe(2)
    expect(consumer.inFlightCount()).toBe(0)
    expect(logger.errors.length).toBeGreaterThanOrEqual(2)
    consumer.stop()
  })

  test('warns and skips when the message has no subagent field', async () => {
    const stream = createStream()
    let calls = 0
    const spawner: SubagentSpawner = async () => {
      calls++
    }
    const logger = silentLogger()

    const consumer = createSubagentConsumer({
      stream,
      spawners: { 'memory-logger': spawner },
      logger,
    })
    consumer.start()

    stream.publish({ target: { kind: 'new-session' }, payload: null })
    await sleep(0)

    expect(calls).toBe(0)
    expect(logger.warns.length).toBeGreaterThan(0)
    consumer.stop()
  })

  test('warns and skips when the subagent has no registered spawner', async () => {
    const stream = createStream()
    let calls = 0
    const logger = silentLogger()

    const consumer = createSubagentConsumer({
      stream,
      spawners: { 'memory-logger': async () => void calls++ },
      logger,
    })
    consumer.start()

    stream.publish({ target: { kind: 'new-session', subagent: 'unknown-role' }, payload: null })
    await sleep(0)

    expect(calls).toBe(0)
    expect(logger.warns.length).toBeGreaterThan(0)
    consumer.stop()
  })

  test('stop() unsubscribes; further messages are not delivered', async () => {
    const stream = createStream()
    let calls = 0
    const spawner: SubagentSpawner = async () => {
      calls++
    }
    const consumer = createSubagentConsumer({
      stream,
      spawners: { 'memory-logger': spawner },
      logger: silentLogger(),
    })
    consumer.start()
    consumer.stop()

    stream.publish({ target: { kind: 'new-session', subagent: 'memory-logger' }, payload: null })
    await sleep(10)

    expect(calls).toBe(0)
  })

  test('start() is idempotent (calling twice does not double-deliver)', async () => {
    const stream = createStream()
    let calls = 0
    const spawner: SubagentSpawner = async () => {
      calls++
    }
    const consumer = createSubagentConsumer({
      stream,
      spawners: { 'memory-logger': spawner },
      logger: silentLogger(),
    })
    consumer.start()
    consumer.start()

    stream.publish({ target: { kind: 'new-session', subagent: 'memory-logger' }, payload: null })
    await sleep(0)

    expect(calls).toBe(1)
    consumer.stop()
  })
})
