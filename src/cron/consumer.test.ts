import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import type { HookBus } from '@/plugin'
import { createStream } from '@/stream'

import { createCronConsumer, type CronConsumerLogger, type CronSession } from './consumer'
import type { CronJob, ExecJob, PromptJob } from './schema'

// Minimal AgentSession stub satisfying the surface the model-fallback helper
// uses: `subscribe` for soft-error detection (returns a no-op unsubscribe)
// and `prompt` for the actual turn call. Production code routes the prompt
// through CronSession.prompt (which itself calls AgentSession.prompt), but
// the fallback helper bypasses the wrapper and calls AgentSession.prompt
// directly — so the stub has to honor the same callback to keep the test
// fakes behaving like their pre-fallback predecessors.
function stubAgentSession(promptImpl: (text: string) => Promise<void> = async () => {}): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: promptImpl,
  } as unknown as AgentSession
}

function fakeHooks(events: string[]): HookBus {
  return {
    registerAll: () => {},
    unregisterAll: () => {},
    runSessionStart: async () => {},
    runSessionEnd: async (e) => {
      events.push(`end:${e.sessionId}`)
    },
    runSessionIdle: async (e) => {
      events.push(`idle:${e.sessionId}:${e.parentTranscriptPath ?? '-'}`)
    },
    runSessionPrompt: async () => {},
    runSessionTurnStart: async () => {},
    runSessionTurnEnd: async () => {},
    runToolBefore: async () => undefined,
    runToolAfter: async () => {},
    count: () => 0,
  }
}

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
    createSessionForCron: async (job) => {
      const record = (text: string) => {
        const existing = callsByJob.get(job.id) ?? []
        existing.push(text)
        callsByJob.set(job.id, existing)
      }
      return {
        prompt: async (text) => record(text),
        session: stubAgentSession(async (text) => record(text)),
      }
    },
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

    expect(factory.callsByJob.get('greet')).toEqual([expect.stringContaining('say hi')])

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

  test('exec job spawn injects TYPECLAW_PARENT_ORIGIN_JSON describing the cron job', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    const job: ExecJob = {
      id: 'nightly-checks',
      schedule: '* * * * *',
      enabled: true,
      kind: 'exec',
      command: ['sh', '-c', 'printf "%s" "$TYPECLAW_PARENT_ORIGIN_JSON" > origin.json'],
      scheduledByRole: 'member',
    }
    publishCron(stream, job)
    await new Promise((r) => setTimeout(r, 80))

    const captured = await Bun.file(join(root, 'origin.json')).text()
    const parsed = JSON.parse(captured) as { kind?: string; jobId?: string; scheduledByRole?: string }
    expect(parsed.kind).toBe('cron')
    expect(parsed.jobId).toBe('nightly-checks')
    expect(parsed.scheduledByRole).toBe('member')

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

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('slow:')
    expect(calls[0]).toContain('first')
    expect(consumer.inFlightCount()).toBe(1)

    releaseBox.fn?.()
    await new Promise((r) => setImmediate(r))

    publishCron(stream, promptJob('slow', 'third'))
    await new Promise((r) => setImmediate(r))

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.some((c) => c.startsWith('slow:') && c.includes('third'))).toBe(true)

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

    expect(factory.callsByJob.get('once')).toEqual([expect.stringContaining('hi')])

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

  test('a prompt job with a subagent field publishes a new-session message instead of running the prompt', async () => {
    // given
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const newSessionMessages: Array<{ subagent: string; payload: unknown }> = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => {
      const target = msg.target as { kind: 'new-session'; subagent: string }
      newSessionMessages.push({ subagent: target.subagent, payload: msg.payload })
    })
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, {
      id: 'sub-job',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'fallback user prompt',
      subagent: 'dreaming',
      payload: { agentDir: '/some/path' },
    })
    await new Promise((r) => setImmediate(r))

    // then
    expect(newSessionMessages).toEqual([{ subagent: 'dreaming', payload: { agentDir: '/some/path' } }])
    expect(factory.callsByJob.size).toBe(0)

    consumer.stop()
  })

  test('a prompt job without a subagent runs createSessionForCron and never publishes new-session', async () => {
    // given
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const newSessionMessages: unknown[] = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => newSessionMessages.push(msg))
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('plain', 'hello'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(factory.callsByJob.get('plain')).toEqual([expect.stringContaining('hello')])
    expect(newSessionMessages).toEqual([])

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

  test('fires session.idle and session.end on the supplied HookBus around each prompt run', async () => {
    // given
    const stream = createStream()
    const events: string[] = []
    const hooks = fakeHooks(events)
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async (text: string) => {
          events.push(`prompt:${text}`)
        },
        hooks,
        sessionId: 'cron-sess-1',
        getTranscriptPath: () => '/tmp/transcript-1.jsonl',
      }),
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('hooked', 'do work'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(events).toHaveLength(3)
    expect(events[0]).toStartWith('prompt:')
    expect(events[0]).toContain('do work')
    expect(events[1]).toBe('idle:cron-sess-1:/tmp/transcript-1.jsonl')
    expect(events[2]).toBe('end:cron-sess-1')

    consumer.stop()
  })

  test('fires session.end even when prompt throws so plugins can react to abnormal termination', async () => {
    // given
    const stream = createStream()
    const events: string[] = []
    const hooks = fakeHooks(events)
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async () => {
          throw new Error('llm down')
        },
        hooks,
        sessionId: 'cron-boom',
      }),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('boom', 'go'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(events).toEqual(['end:cron-boom'])
    expect(errors.some((e) => /llm down/.test(e))).toBe(true)

    consumer.stop()
  })

  test('logs LLM soft errors (stopReason=error encoded in message_end) so `typeclaw logs` surfaces them', async () => {
    // given: a fake CronSession whose .session emits a message_end with
    // stopReason=error during prompt(), simulating a billing/rate-limit
    // failure from pi-coding-agent that resolves normally instead of throwing.
    const stream = createStream()
    const errors: string[] = []
    type Listener = (event: { type: string; message?: unknown }) => void
    const listeners = new Set<Listener>()
    const fakeAgentSession = {
      subscribe: (cb: Listener) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    } as unknown as import('@/agent').AgentSession

    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async () => {
          for (const cb of listeners) {
            cb({
              type: 'message_end',
              message: {
                role: 'assistant',
                stopReason: 'error',
                errorMessage: 'rate limit exceeded',
              },
            })
          }
        },
        session: fakeAgentSession,
      }),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('soft-err', 'go'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors.some((e) => /\[cron\] soft-err:.*rate limit exceeded/.test(e))).toBe(true)

    consumer.stop()
  })

  test('does not log when .session is omitted (test fakes that only need prompt keep working)', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async () => {},
      }),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('no-session', 'go'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors).toEqual([])

    consumer.stop()
  })

  test('dispatches a handler job through invokeHandler', async () => {
    // given
    const stream = createStream()
    const seen: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async (job) => {
        seen.push(job.id)
      },
      logger: silentLogger,
    })
    consumer.start()

    // when
    const handlerJob: CronJob = {
      id: 'inbox-watch',
      schedule: '* * * * *',
      enabled: true,
      kind: 'handler',
      handler: async () => {},
      scheduledByRole: 'owner',
    }
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))

    // then
    expect(seen).toEqual(['inbox-watch'])

    consumer.stop()
  })

  test('handler job errors are caught and logged, not propagated', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async () => {
        throw new Error('handler exploded')
      },
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    const handlerJob: CronJob = {
      id: 'broken',
      schedule: '* * * * *',
      enabled: true,
      kind: 'handler',
      handler: async () => {
        throw new Error('handler exploded')
      },
      scheduledByRole: 'owner',
    }
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors).toEqual([expect.stringContaining('broken failed: handler exploded')])

    consumer.stop()
  })

  test('handler job dispatched without invokeHandler logs a precise error', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    const handlerJob: CronJob = {
      id: 'orphan',
      schedule: '* * * * *',
      enabled: true,
      kind: 'handler',
      handler: async () => {},
      scheduledByRole: 'owner',
    }
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors).toEqual([expect.stringContaining('no invokeHandler wired')])

    consumer.stop()
  })

  test('handler jobs respect in-flight coalescing keyed by jobId', async () => {
    // given
    const stream = createStream()
    const warns: string[] = []
    const resolvers: (() => void)[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve)
        }),
      logger: { ...silentLogger, warn: (m) => warns.push(m) },
    })
    consumer.start()

    // when - first publish blocks; second arrives before first resolves
    const handlerJob: CronJob = {
      id: 'busy',
      schedule: '* * * * *',
      enabled: true,
      kind: 'handler',
      handler: async () => {},
      scheduledByRole: 'owner',
    }
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))

    // then
    expect(warns).toEqual([expect.stringContaining('busy: previous run still in progress, skipping')])

    for (const r of resolvers) r()
    consumer.stop()
  })
})

describe('createCronConsumer model fallback', () => {
  test('retries with the next ref when the first model throws, and the factory receives the override', async () => {
    // given: a multi-ref default chain on disk + reloaded into the live config
    const { writeFile } = await import('node:fs/promises')
    const { reloadConfig, __resetConfigForTesting } = await import('@/config/config')
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'],
        },
      }),
    )
    reloadConfig(root)
    try {
      const stream = createStream()
      const calls: string[] = []
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        createSessionForCron: async (job, ref) => {
          calls.push(`${job.id}:${ref}`)
          const fail = ref === 'openai/gpt-5.4-nano'
          return {
            prompt: async (text) => {
              if (fail) throw new Error(`provider error on ${ref}`)
              calls.push(`${job.id}:${ref}:ok:${text}`)
            },
            session: stubAgentSession(async (text) => {
              if (fail) throw new Error(`provider error on ${ref}`)
              calls.push(`${job.id}:${ref}:ok:${text}`)
            }),
          }
        },
        logger: silentLogger,
      })
      consumer.start()

      // when
      publishCron(stream, promptJob('fb', 'do thing'))
      await new Promise((r) => setImmediate(r))

      // then: the consumer called createSessionForCron once per ref in chain
      // order, and the second attempt's prompt was actually invoked
      expect(calls).toHaveLength(3)
      expect(calls[0]).toBe('fb:openai/gpt-5.4-nano')
      expect(calls[1]).toBe('fb:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
      expect(calls[2]).toMatch(/^fb:fireworks\/accounts\/fireworks\/routers\/kimi-k2p6-turbo:ok:/)
      expect(calls[2]).toContain('do thing')

      consumer.stop()
    } finally {
      __resetConfigForTesting()
    }
  })

  test('logs final-attempt failure when every ref in the chain fails, and attempts every ref in order', async () => {
    // given
    const { writeFile } = await import('node:fs/promises')
    const { reloadConfig, __resetConfigForTesting } = await import('@/config/config')
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'],
        },
      }),
    )
    reloadConfig(root)
    try {
      const stream = createStream()
      const errors: string[] = []
      const attempted: string[] = []
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        createSessionForCron: async (_job, ref) => {
          attempted.push(ref!)
          return {
            prompt: async () => {
              throw new Error(`down: ${ref}`)
            },
            session: stubAgentSession(async () => {
              throw new Error(`down: ${ref}`)
            }),
          }
        },
        logger: { ...silentLogger, error: (m) => errors.push(m) },
      })
      consumer.start()

      // when
      publishCron(stream, promptJob('all-down', 'attempt'))
      await new Promise((r) => setImmediate(r))

      // then
      expect(attempted).toEqual(['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'])
      expect(errors.some((e) => /all 2 model\(s\) failed/.test(e))).toBe(true)
      expect(errors.some((e) => /down: fireworks/.test(e))).toBe(true)

      consumer.stop()
    } finally {
      __resetConfigForTesting()
    }
  })

  test('disposes the successful final session and fires session.end exactly once per attempted session', async () => {
    // given: a 2-ref chain where the first fails and the second succeeds.
    // We track disposal calls per session and assert that BOTH sessions get
    // their dispose+end hooks fired — without that, security plugin taint
    // state and memory plugin debounce timers would orphan for the failed
    // first attempt, and the successful session's resources would leak.
    const { writeFile } = await import('node:fs/promises')
    const { reloadConfig, __resetConfigForTesting } = await import('@/config/config')
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'],
        },
      }),
    )
    reloadConfig(root)
    try {
      const stream = createStream()
      const events: string[] = []
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        createSessionForCron: async (_job, ref) => {
          const fail = ref === 'openai/gpt-5.4-nano'
          const sessionId = `sess:${ref}`
          const hooks: HookBus = {
            registerAll: () => {},
            unregisterAll: () => {},
            runSessionStart: async () => {},
            runSessionEnd: async (e) => {
              events.push(`end:${e.sessionId}`)
            },
            runSessionIdle: async (e) => {
              events.push(`idle:${e.sessionId}`)
            },
            runSessionPrompt: async () => {},
            runSessionTurnStart: async () => {},
            runSessionTurnEnd: async () => {},
            runToolBefore: async () => undefined,
            runToolAfter: async () => {},
            count: () => 0,
          }
          return {
            prompt: async () => {
              if (fail) throw new Error(`down on ${ref}`)
            },
            session: stubAgentSession(async () => {
              if (fail) throw new Error(`down on ${ref}`)
            }),
            hooks,
            sessionId,
            agentDir: '/agent',
            dispose: () => {
              events.push(`dispose:${sessionId}`)
            },
          }
        },
        logger: silentLogger,
      })
      consumer.start()

      // when
      publishCron(stream, promptJob('fb', 'go'))
      await new Promise((r) => setImmediate(r))

      // then: failed session gets end+dispose (no idle), successful session
      // gets idle+end+dispose, all in the right order
      expect(events).toEqual([
        'end:sess:openai/gpt-5.4-nano',
        'dispose:sess:openai/gpt-5.4-nano',
        'idle:sess:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        'end:sess:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        'dispose:sess:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      ])

      consumer.stop()
    } finally {
      __resetConfigForTesting()
    }
  })
})
