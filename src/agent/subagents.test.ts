import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { HookBus } from '@/plugin'
import { createStream } from '@/stream'

import type { AgentSession } from './index'
import { createSubagentConsumer, invokeSubagent, type Subagent, validateSubagentPayload } from './subagents'

function makeFakeHookBus(events: string[]): HookBus {
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
    runToolBefore: async () => undefined,
    runToolAfter: async () => {},
    count: () => 0,
  }
}

function fakeSession(): { session: AgentSession; calls: { prompt: string[]; disposed: number } } {
  const calls = { prompt: [] as string[], disposed: 0 }
  const session = {
    prompt: async (text: string) => {
      calls.prompt.push(text)
    },
    dispose: () => {
      calls.disposed += 1
    },
  } as unknown as AgentSession
  return { session, calls }
}

describe('validateSubagentPayload', () => {
  test('returns parsed payload when schema matches', () => {
    // given
    const schema = z.object({ id: z.string() })
    const subagent: Subagent<{ id: string }> = { systemPrompt: 'X', payloadSchema: schema }

    // when
    const result = validateSubagentPayload('test', subagent, { id: 'abc' })

    // then
    expect(result).toEqual({ id: 'abc' })
  })

  test('throws when schema does not match', () => {
    // given
    const schema = z.object({ id: z.string() })
    const subagent: Subagent<{ id: string }> = { systemPrompt: 'X', payloadSchema: schema }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, { id: 42 })).toThrow(/invalid payload/)
  })

  test('throws when subagent has no schema but payload is provided', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, { foo: 'bar' })).toThrow(/does not accept a payload/)
  })

  test('error message describes the received value type to disambiguate undefined vs null vs object', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, null)).toThrow(/received null/)
    expect(() => validateSubagentPayload('test', subagent, { foo: 1 })).toThrow(/received object/)
    expect(() => validateSubagentPayload('test', subagent, [1, 2])).toThrow(/received array/)
    expect(() => validateSubagentPayload('test', subagent, 'oops')).toThrow(/received string/)
  })

  test('passes when subagent has no schema and payload is undefined', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when
    const result = validateSubagentPayload('test', subagent, undefined)

    // then
    expect(result).toBeUndefined()
  })
})

describe('invokeSubagent', () => {
  test('throws on unknown subagent name', async () => {
    // when / then
    await expect(
      invokeSubagent('missing', {
        registry: {},
        createSessionForSubagent: async () => fakeSession().session,
        agentDir: '/agent',
        userPrompt: 'hi',
      }),
    ).rejects.toThrow(/unknown subagent: missing/)
  })

  test('default execution prompts the session with the user prompt and disposes', async () => {
    // given
    const { session, calls } = fakeSession()
    const registry = { greeter: { systemPrompt: 'You are a greeter.' } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'say hello',
    })

    // then
    expect(calls.prompt).toEqual(['say hello'])
    expect(calls.disposed).toBe(1)
  })

  test('handler receives validated payload and runs runSession when called', async () => {
    // given
    const { session, calls } = fakeSession()
    const schema = z.object({ name: z.string() })
    const registry = {
      greeter: {
        systemPrompt: 'You are a greeter.',
        payloadSchema: schema,
        handler: async (ctx, runSession) => {
          await runSession({ userPrompt: `hello ${ctx.payload.name}` })
        },
      } satisfies Subagent<{ name: string }>,
    }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'unused default',
      payload: { name: 'Neo' },
    })

    // then
    expect(calls.prompt).toEqual(['hello Neo'])
    expect(calls.disposed).toBe(1)
  })

  test('handler may skip the session entirely', async () => {
    // given
    const { session, calls } = fakeSession()
    const registry = {
      lazy: {
        systemPrompt: 'X',
        handler: async () => {
          // intentionally never call runSession
        },
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('lazy', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'whatever',
    })

    // then
    expect(calls.prompt).toEqual([])
    expect(calls.disposed).toBe(0)
  })

  test('handler may call runSession multiple times, creating fresh sessions each time', async () => {
    // given
    const fakes: ReturnType<typeof fakeSession>[] = []
    const registry = {
      twice: {
        systemPrompt: 'X',
        handler: async (_ctx, runSession) => {
          await runSession({ userPrompt: 'first' })
          await runSession({ userPrompt: 'second' })
        },
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('twice', {
      registry,
      createSessionForSubagent: async () => {
        const f = fakeSession()
        fakes.push(f)
        return f.session
      },
      agentDir: '/agent',
      userPrompt: 'unused',
    })

    // then
    expect(fakes).toHaveLength(2)
    expect(fakes[0]!.calls.prompt).toEqual(['first'])
    expect(fakes[1]!.calls.prompt).toEqual(['second'])
    expect(fakes[0]!.calls.disposed).toBe(1)
    expect(fakes[1]!.calls.disposed).toBe(1)
  })

  test('payload validation errors surface before any session is created', async () => {
    // given
    let createCalled = false
    const schema = z.object({ id: z.string() })
    const registry = {
      strict: { systemPrompt: 'X', payloadSchema: schema, handler: async () => {} } satisfies Subagent<{ id: string }>,
    }

    // when / then
    await expect(
      invokeSubagent('strict', {
        registry,
        createSessionForSubagent: async () => {
          createCalled = true
          return fakeSession().session
        },
        agentDir: '/agent',
        userPrompt: 'x',
        payload: { id: 42 },
      }),
    ).rejects.toThrow(/invalid payload/)
    expect(createCalled).toBe(false)
  })

  test('disposes the session even when the prompt throws', async () => {
    // given
    const calls = { disposed: 0 }
    const session = {
      prompt: async () => {
        throw new Error('boom')
      },
      dispose: () => {
        calls.disposed += 1
      },
    } as unknown as AgentSession
    const registry = { fragile: { systemPrompt: 'X' } satisfies Subagent }

    // when / then
    await expect(
      invokeSubagent('fragile', {
        registry,
        createSessionForSubagent: async () => session,
        agentDir: '/agent',
        userPrompt: 'crash',
      }),
    ).rejects.toThrow(/boom/)
    expect(calls.disposed).toBe(1)
  })

  test('fires session.idle and session.end on the supplied HookBus around runSession', async () => {
    // given
    const { session } = fakeSession()
    const events: string[] = []
    const hooks = makeFakeHookBus(events)
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => ({
        session,
        hooks,
        sessionId: 'sub-sess-1',
        getTranscriptPath: () => '/tmp/sub-transcript.jsonl',
      }),
      agentDir: '/agent',
      userPrompt: 'hi',
    })

    // then
    expect(events).toEqual(['idle:sub-sess-1:/tmp/sub-transcript.jsonl', 'end:sub-sess-1'])
  })

  test('fires session.end even when the prompt throws so plugins can react to abnormal subagent termination', async () => {
    // given
    const events: string[] = []
    const hooks = makeFakeHookBus(events)
    const session = {
      prompt: async () => {
        throw new Error('subagent boom')
      },
      dispose: () => {},
    } as unknown as AgentSession
    const registry = { fragile: { systemPrompt: 'X' } satisfies Subagent }

    // when / then
    await expect(
      invokeSubagent('fragile', {
        registry,
        createSessionForSubagent: async () => ({ session, hooks, sessionId: 'sub-boom' }),
        agentDir: '/agent',
        userPrompt: 'crash',
      }),
    ).rejects.toThrow(/subagent boom/)
    expect(events).toEqual(['end:sub-boom'])
  })
})

describe('createSubagentConsumer', () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {} }

  function fakeAgentSession(prompts: string[]): AgentSession {
    return {
      prompt: async (text: string) => {
        prompts.push(text)
      },
      dispose: () => {},
    } as unknown as AgentSession
  }

  test('dispatches a new-session message to the registered subagent handler', async () => {
    // given
    const stream = createStream()
    const handlerCalls: { payload: unknown }[] = []
    const registry = {
      greeter: {
        systemPrompt: 'X',
        payloadSchema: z.object({ who: z.string() }),
        handler: async (ctx) => {
          handlerCalls.push({ payload: ctx.payload })
        },
      } satisfies Subagent<{ who: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      logger: silent,
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'greeter' }, payload: { who: 'neo' } })
    await new Promise((r) => setImmediate(r))

    // then
    expect(handlerCalls).toEqual([{ payload: { who: 'neo' } }])

    consumer.stop()
  })

  test('warns and ignores messages for unregistered subagent names', async () => {
    // given
    const stream = createStream()
    const warnings: string[] = []
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => ({}),
      agentDir: '/agent',
      logger: { ...silent, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'no-such-thing' }, payload: null })
    await new Promise((r) => setImmediate(r))

    // then
    expect(warnings.some((w) => /no registered subagent/.test(w))).toBe(true)

    consumer.stop()
  })

  test('coalesces concurrent invocations using inFlightKey', async () => {
    // given: a slow subagent and an inFlightKey that ignores payload, so two
    // concurrent messages collapse into one execution.
    const stream = createStream()
    const handlerCalls: number[] = []
    let resolveFirst: () => void = () => {}
    const registry = {
      slow: {
        systemPrompt: 'X',
        handler: async () => {
          handlerCalls.push(1)
          await new Promise<void>((r) => {
            resolveFirst = r
          })
        },
      } satisfies Subagent,
    }
    const warnings: string[] = []
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      inFlightKey: (name) => name,
      logger: { ...silent, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    // when: two messages fire while the first is still running
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: undefined })
    await new Promise((r) => setImmediate(r))
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: undefined })
    await new Promise((r) => setImmediate(r))

    // then: only one handler call so far; the second was coalesced
    expect(handlerCalls).toEqual([1])
    expect(warnings.some((w) => /previous run still in progress/.test(w))).toBe(true)

    resolveFirst()
    await new Promise((r) => setImmediate(r))
    consumer.stop()
  })

  test('different inFlightKey buckets allow concurrent execution', async () => {
    // given
    const stream = createStream()
    const concurrent: string[] = []
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })
    const registry = {
      bucketed: {
        systemPrompt: 'X',
        payloadSchema: z.object({ id: z.string() }),
        handler: async (ctx) => {
          concurrent.push(`start:${ctx.payload.id}`)
          await gate
          concurrent.push(`end:${ctx.payload.id}`)
        },
      } satisfies Subagent<{ id: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      inFlightKey: (name, payload) => `${name}:${(payload as { id: string }).id}`,
      logger: silent,
    })
    consumer.start()

    // when: two messages with different IDs fire while the first is gated
    stream.publish({ target: { kind: 'new-session', subagent: 'bucketed' }, payload: { id: 'a' } })
    stream.publish({ target: { kind: 'new-session', subagent: 'bucketed' }, payload: { id: 'b' } })
    await new Promise((r) => setImmediate(r))

    // then: both handlers started before either finished
    expect(concurrent.filter((s) => s.startsWith('start:'))).toEqual(['start:a', 'start:b'])

    releaseGate()
    await new Promise((r) => setImmediate(r))
    consumer.stop()
  })

  test('removes inFlight entry when handler throws', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const registry = {
      explodes: {
        systemPrompt: 'X',
        handler: async () => {
          throw new Error('boom')
        },
      } satisfies Subagent,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      logger: { ...silent, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'explodes' }, payload: undefined })
    await new Promise((r) => setImmediate(r))

    // then: the error was logged and inFlight is now empty
    expect(errors.some((e) => /boom/.test(e))).toBe(true)
    expect(consumer.inFlightCount()).toBe(0)

    consumer.stop()
  })
})
