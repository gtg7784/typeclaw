import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStream } from '@/stream'

import { createCronConsumer, type CronConsumerLogger, type CronSession } from './consumer'
import type { CronJob, ExecJob, PromptJob, SubagentJob } from './schema'

const silentLogger: CronConsumerLogger = { info: () => {}, warn: () => {}, error: () => {} }

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-cron-consumer-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const promptJob = (id: string, prompt: string): PromptJob => ({
  id,
  schedule: '* * * * *',
  enabled: true,
  kind: 'prompt',
  prompt,
})

const execJob = (id: string, command: string[]): ExecJob => ({
  id,
  schedule: '* * * * *',
  enabled: true,
  kind: 'exec',
  command,
})

function publishCron(stream: ReturnType<typeof createStream>, job: CronJob): string {
  return stream.publish({ target: { kind: 'cron', jobId: job.id }, payload: job })
}

function makeFakeSessionFactory(): {
  createSessionForCron: (job: PromptJob) => Promise<CronSession>
  callsByJob: Map<string, string[]>
} {
  const callsByJob = new Map<string, string[]>()
  return {
    callsByJob,
    createSessionForCron: async (job) => ({
      prompt: async (text) => {
        const existing = callsByJob.get(job.id) ?? []
        existing.push(text)
        callsByJob.set(job.id, existing)
      },
    }),
  }
}

describe('createCronConsumer', () => {
  test('dispatches a prompt job to createSessionForCron and forwards the prompt text', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('greet', 'say hi'))
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.get('greet')).toEqual(['say hi'])

    consumer.stop()
  })

  test('dispatches an exec job and runs the configured command in cwd', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, execJob('touch', ['sh', '-c', 'echo hello > out.txt']))
    await new Promise((r) => setTimeout(r, 50))

    const contents = await Bun.file(join(root, 'out.txt')).text()
    expect(contents.trim()).toBe('hello')

    consumer.stop()
  })

  test('exec job exiting non-zero is logged but does not crash the consumer', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    publishCron(stream, execJob('fail', ['sh', '-c', 'exit 3']))
    await new Promise((r) => setTimeout(r, 50))

    expect(errors.some((e) => /exited with code 3/.test(e))).toBe(true)

    publishCron(stream, execJob('after', ['sh', '-c', 'echo ok > after.txt']))
    await new Promise((r) => setTimeout(r, 50))

    const contents = await Bun.file(join(root, 'after.txt')).text()
    expect(contents.trim()).toBe('ok')

    consumer.stop()
  })

  test('exec job with empty command array fails with a clear error', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    publishCron(stream, { id: 'empty', schedule: '* * * * *', enabled: true, kind: 'exec', command: [] } as ExecJob)
    await new Promise((r) => setTimeout(r, 20))

    expect(errors.some((e) => /empty command/.test(e))).toBe(true)

    consumer.stop()
  })

  test('coalesces a second fire for the same jobId while the first is in flight', async () => {
    const stream = createStream()
    const calls: string[] = []
    const releaseBox: { fn: (() => void) | null } = { fn: null }
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async (job) => ({
        prompt: async (text) => {
          calls.push(`${job.id}:${text}`)
          await new Promise<void>((resolve) => {
            releaseBox.fn = resolve
          })
        },
      }),
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('slow', 'first'))
    await new Promise((r) => setImmediate(r))
    publishCron(stream, promptJob('slow', 'second'))
    await new Promise((r) => setImmediate(r))

    expect(calls).toEqual(['slow:first'])
    expect(consumer.inFlightCount()).toBe(1)

    releaseBox.fn?.()
    await new Promise((r) => setImmediate(r))

    publishCron(stream, promptJob('slow', 'third'))
    await new Promise((r) => setImmediate(r))

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.includes('slow:third')).toBe(true)

    consumer.stop()
  })

  test('different jobIds run concurrently — coalescing is per-job, not global', async () => {
    const stream = createStream()
    const released = new Set<string>()
    const releases: { a: (() => void) | null; b: (() => void) | null } = { a: null, b: null }
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async (job) => ({
        prompt: async () => {
          await new Promise<void>((resolve) => {
            if (job.id === 'a')
              releases.a = () => {
                released.add('a')
                resolve()
              }
            if (job.id === 'b')
              releases.b = () => {
                released.add('b')
                resolve()
              }
          })
        },
      }),
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('a', 'go-a'))
    publishCron(stream, promptJob('b', 'go-b'))
    await new Promise((r) => setImmediate(r))

    expect(consumer.inFlightCount()).toBe(2)

    releases.a?.()
    releases.b?.()
    await new Promise((r) => setImmediate(r))
    expect(released).toEqual(new Set(['a', 'b']))

    consumer.stop()
  })

  test('an in-flight job survives cleanly even after stop() is called', async () => {
    const stream = createStream()
    const releaseBox: { fn: (() => void) | null } = { fn: null }
    let completed = false
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async () => {
          await new Promise<void>((resolve) => {
            releaseBox.fn = resolve
          })
          completed = true
        },
      }),
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('long', 'wait'))
    await new Promise((r) => setImmediate(r))
    expect(consumer.inFlightCount()).toBe(1)

    consumer.stop()
    releaseBox.fn?.()
    await new Promise((r) => setImmediate(r))

    expect(completed).toBe(true)
  })

  test('after stop(), new published cron messages are ignored', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()
    consumer.stop()

    publishCron(stream, promptJob('lost', 'no-one-home'))
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.size).toBe(0)
  })

  test('start() is idempotent', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()
    consumer.start()

    publishCron(stream, promptJob('once', 'hi'))
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.get('once')).toEqual(['hi'])

    consumer.stop()
  })

  test('ignores cron messages with malformed payloads', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const warnings: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: { ...silentLogger, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    stream.publish({ target: { kind: 'cron', jobId: 'bogus' }, payload: { wrong: true } })
    await new Promise((r) => setImmediate(r))

    expect(warnings.some((w) => /invalid payload/.test(w))).toBe(true)
    expect(factory.callsByJob.size).toBe(0)

    consumer.stop()
  })

  test('dispatches a subagent job by publishing a new-session message to the stream', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    const newSessionMessages: Array<{ subagent?: string; payload: unknown }> = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => {
      const target = msg.target as { kind: 'new-session'; subagent?: string }
      newSessionMessages.push({ subagent: target.subagent, payload: msg.payload })
    })

    const job: SubagentJob = {
      id: 'dream',
      schedule: '0 4 * * *',
      enabled: true,
      kind: 'subagent',
      subagent: 'dreaming',
      payload: { agentDir: '/some/path' },
    }
    publishCron(stream, job)
    await new Promise((r) => setImmediate(r))

    expect(newSessionMessages).toHaveLength(1)
    expect(newSessionMessages[0]?.subagent).toBe('dreaming')
    expect(newSessionMessages[0]?.payload).toEqual({ agentDir: '/some/path' })
    expect(factory.callsByJob.size).toBe(0)

    consumer.stop()
  })

  test('does not consume non-cron-targeted messages', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    stream.publish({ target: { kind: 'broadcast' }, payload: promptJob('would-not-run', 'x') })
    stream.publish({
      target: { kind: 'session', sessionId: 'sess-1' },
      payload: promptJob('also-not', 'x'),
    })
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.size).toBe(0)

    consumer.stop()
  })
})
