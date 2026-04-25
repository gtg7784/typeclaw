import { describe, expect, test } from 'bun:test'

import { createStream } from './broker'
import { StreamTimeoutError, type StreamMessage } from './types'

describe('createStream — publish + subscribe', () => {
  test('subscribers matching the target receive published messages', () => {
    const stream = createStream()
    const seen: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      seen.push(msg)
    })

    stream.publish({ target: { kind: 'broadcast' }, payload: { hello: 'world' } })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.payload).toEqual({ hello: 'world' })
    expect(seen[0]?.target).toEqual({ kind: 'broadcast' })
    expect(seen[0]?.id).toMatch(/^s_/)
    expect(seen[0]?.ts).toBeGreaterThan(0)
  })

  test('publish returns the assigned message id', () => {
    const stream = createStream()
    const id = stream.publish({ target: { kind: 'broadcast' }, payload: 1 })
    expect(id).toMatch(/^s_/)
  })

  test('subscribers not matching the target do not receive the message', () => {
    const stream = createStream()
    const broadcastSeen: StreamMessage[] = []
    const sessionSeen: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => broadcastSeen.push(msg))
    stream.subscribe({ target: { kind: 'session' } }, (msg) => sessionSeen.push(msg))

    stream.publish({ target: { kind: 'broadcast' }, payload: 'hi' })

    expect(broadcastSeen).toHaveLength(1)
    expect(sessionSeen).toHaveLength(0)
  })

  test('broadcast fans out to multiple matching subscribers', () => {
    const stream = createStream()
    let aCount = 0
    let bCount = 0
    stream.subscribe({ target: { kind: 'broadcast' } }, () => {
      aCount++
    })
    stream.subscribe({ target: { kind: 'broadcast' } }, () => {
      bCount++
    })

    stream.publish({ target: { kind: 'broadcast' }, payload: null })

    expect(aCount).toBe(1)
    expect(bCount).toBe(1)
  })

  test('unsubscribe stops further deliveries', () => {
    const stream = createStream()
    let count = 0
    const off = stream.subscribe({ target: { kind: 'broadcast' } }, () => {
      count++
    })

    stream.publish({ target: { kind: 'broadcast' }, payload: null })
    off()
    stream.publish({ target: { kind: 'broadcast' }, payload: null })

    expect(count).toBe(1)
  })

  test('a subscriber that throws does not affect other subscribers', () => {
    const stream = createStream()
    let bGotIt = false
    stream.subscribe({ target: { kind: 'broadcast' } }, () => {
      throw new Error('boom')
    })
    stream.subscribe({ target: { kind: 'broadcast' } }, () => {
      bGotIt = true
    })

    stream.publish({ target: { kind: 'broadcast' }, payload: null })

    expect(bGotIt).toBe(true)
  })

  test('a rejected async subscriber does not affect other subscribers', async () => {
    const stream = createStream()
    let bGotIt = false
    stream.subscribe({ target: { kind: 'broadcast' } }, async () => {
      throw new Error('async boom')
    })
    stream.subscribe({ target: { kind: 'broadcast' } }, () => {
      bGotIt = true
    })

    stream.publish({ target: { kind: 'broadcast' }, payload: null })
    await new Promise((r) => setImmediate(r))

    expect(bGotIt).toBe(true)
  })

  test('preserves replyTo and meta fields on the delivered message', () => {
    const stream = createStream()
    let received: StreamMessage | null = null
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received = msg
    })

    stream.publish({
      target: { kind: 'broadcast' },
      payload: 'p',
      replyTo: 'request-xyz',
      meta: { source: 'test' },
    })

    expect(received).not.toBeNull()
    expect(received!.replyTo).toBe('request-xyz')
    expect(received!.meta).toEqual({ source: 'test' })
  })
})

describe('createStream — target selectors', () => {
  test('session subscriber pinned to one sessionId only sees that session', () => {
    const stream = createStream()
    const seen: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'session', sessionId: 'a' } }, (msg) => seen.push(msg))

    stream.publish({ target: { kind: 'session', sessionId: 'a' }, payload: 1 })
    stream.publish({ target: { kind: 'session', sessionId: 'b' }, payload: 2 })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.payload).toBe(1)
  })

  test('session subscriber without sessionId selector matches all sessions', () => {
    const stream = createStream()
    const seen: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'session' } }, (msg) => seen.push(msg))

    stream.publish({ target: { kind: 'session', sessionId: 'a' }, payload: 1 })
    stream.publish({ target: { kind: 'session', sessionId: 'b' }, payload: 2 })

    expect(seen).toHaveLength(2)
  })

  test('cron subscriber pinned to one jobId only sees that job', () => {
    const stream = createStream()
    const seen: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'cron', jobId: 'daily' } }, (msg) => seen.push(msg))

    stream.publish({ target: { kind: 'cron', jobId: 'daily' }, payload: 1 })
    stream.publish({ target: { kind: 'cron', jobId: 'hourly' }, payload: 2 })

    expect(seen).toHaveLength(1)
  })

  test('cron subscriber without jobId selector receives all cron messages', () => {
    const stream = createStream()
    const seen: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'cron' } }, (msg) => seen.push(msg))

    stream.publish({ target: { kind: 'cron', jobId: 'daily' }, payload: 1 })
    stream.publish({ target: { kind: 'cron', jobId: 'hourly' }, payload: 2 })

    expect(seen).toHaveLength(2)
  })

  test('new-session role selector filters by role', () => {
    const stream = createStream()
    const reflectionSeen: StreamMessage[] = []
    const allNewSeen: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'new-session', role: 'reflection' } }, (msg) => reflectionSeen.push(msg))
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => allNewSeen.push(msg))

    stream.publish({ target: { kind: 'new-session', role: 'reflection' }, payload: 1 })
    stream.publish({ target: { kind: 'new-session' }, payload: 2 })

    expect(reflectionSeen).toHaveLength(1)
    expect(allNewSeen).toHaveLength(2)
  })
})

describe('createStream — replyTo correlation', () => {
  test('subscribers filtering by replyTo only see matching replies', () => {
    const stream = createStream()
    const matched: StreamMessage[] = []
    stream.subscribe({ replyTo: 'req-1' }, (msg) => matched.push(msg))

    stream.publish({ target: { kind: 'broadcast' }, payload: 'a', replyTo: 'req-1' })
    stream.publish({ target: { kind: 'broadcast' }, payload: 'b', replyTo: 'req-2' })
    stream.publish({ target: { kind: 'broadcast' }, payload: 'c' })

    expect(matched).toHaveLength(1)
    expect(matched[0]?.payload).toBe('a')
  })

  test('reply() publishes a message with replyTo set', () => {
    const stream = createStream()
    let received: StreamMessage | null = null
    stream.subscribe({ replyTo: 'orig-id' }, (msg) => {
      received = msg
    })

    stream.reply('orig-id', { result: 42 })

    expect(received).not.toBeNull()
    expect(received!.replyTo).toBe('orig-id')
    expect(received!.payload).toEqual({ result: 42 })
  })
})

describe('createStream — publishAndAwait', () => {
  test('resolves when a matching reply is published', async () => {
    const stream = createStream()

    stream.subscribe({ target: { kind: 'session', sessionId: 'sub' } }, (msg) => {
      stream.reply(msg.id, { ok: true })
    })

    const reply = await stream.publishAndAwait(
      { target: { kind: 'session', sessionId: 'sub' }, payload: 'q' },
      { timeoutMs: 1000 },
    )

    expect(reply.payload).toEqual({ ok: true })
  })

  test('rejects with StreamTimeoutError when no reply arrives in time', async () => {
    const stream = createStream()

    await expect(
      stream.publishAndAwait({ target: { kind: 'broadcast' }, payload: 'q' }, { timeoutMs: 25 }),
    ).rejects.toThrow(StreamTimeoutError)
  })

  test('a late reply after timeout is harmless', async () => {
    const stream = createStream()

    let capturedRequestId: string | null = null
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      if (msg.replyTo !== undefined) return
      capturedRequestId = msg.id
    })

    await expect(
      stream.publishAndAwait({ target: { kind: 'broadcast' }, payload: 'q' }, { timeoutMs: 25 }),
    ).rejects.toThrow(StreamTimeoutError)

    expect(capturedRequestId).not.toBeNull()
    stream.reply(capturedRequestId!, { ignored: true })
  })

  test('only the first matching reply resolves the await', async () => {
    const stream = createStream()
    let replyCount = 0
    stream.subscribe({ target: { kind: 'session', sessionId: 'sub' } }, (msg) => {
      stream.reply(msg.id, { n: ++replyCount })
      stream.reply(msg.id, { n: ++replyCount })
    })

    const reply = await stream.publishAndAwait(
      { target: { kind: 'session', sessionId: 'sub' }, payload: 'q' },
      { timeoutMs: 1000 },
    )

    expect(reply.payload).toEqual({ n: 1 })
  })
})
