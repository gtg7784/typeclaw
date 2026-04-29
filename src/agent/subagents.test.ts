import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { AgentSession } from './index'
import { invokeSubagent, type Subagent, validateSubagentPayload } from './subagents'

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
})
