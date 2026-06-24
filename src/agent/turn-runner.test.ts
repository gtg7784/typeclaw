import { describe, expect, test } from 'bun:test'

import type { ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { promptPersistentTurnWithFallback } from './turn-runner'

const REF_A = 'openai/gpt-5.4-nano' as ModelRef
const REF_B = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' as ModelRef

type FakeEvent = { type: string; message?: unknown; assistantMessageEvent?: { type: string; delta?: string } }

function fakeSession(
  behaviors: Array<'soft-throttle' | 'soft-billing' | 'text-then-throttle' | 'tool-then-throttle' | 'success'>,
) {
  const events: Array<(event: FakeEvent) => void> = []
  const prompted: string[] = []
  const setModels: ModelRef[] = []
  const session = {
    prompt: async (text: string) => {
      prompted.push(text)
      const behavior = behaviors.shift() ?? 'success'
      if (behavior === 'text-then-throttle') {
        for (const cb of events)
          cb({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })
      }
      if (behavior === 'tool-then-throttle') {
        for (const cb of events) cb({ type: 'tool_execution_start' })
      }
      if (behavior !== 'success') {
        const message = behavior === 'soft-billing' ? 'billing required' : 'server_is_overloaded'
        for (const cb of events) {
          cb({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: message } })
        }
      }
    },
    subscribe: (cb: (event: FakeEvent) => void) => {
      events.push(cb)
      return () => {
        const idx = events.indexOf(cb)
        if (idx >= 0) events.splice(idx, 1)
      }
    },
    abortRetry: () => {},
    setModel: async (_model: unknown) => {},
  } as unknown as AgentSession
  return { session, prompted, setModels }
}

describe('promptPersistentTurnWithFallback', () => {
  test('advances to the next ref on throttle before assistant output or tools', async () => {
    const fake = fakeSession(['soft-throttle', 'success'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentRef: REF_A,
      session: fake.session,
      text: 'hello',
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_B)
    expect(fake.prompted).toEqual(['hello', 'hello'])
    expect(fake.setModels).toEqual([REF_B])
  })

  test('does not advance when the throttle happens after assistant text', async () => {
    const fake = fakeSession(['text-then-throttle'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentRef: REF_A,
      session: fake.session,
      text: 'hello',
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.prompted).toEqual(['hello'])
    expect(fake.setModels).toEqual([])
  })

  test('does not advance when the throttle happens after tool execution starts', async () => {
    const fake = fakeSession(['tool-then-throttle'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentRef: REF_A,
      session: fake.session,
      text: 'hello',
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.setModels).toEqual([])
  })

  test('does not advance for non-throttle soft errors', async () => {
    const fake = fakeSession(['soft-billing'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentRef: REF_A,
      session: fake.session,
      text: 'hello',
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.setModels).toEqual([])
  })

  test('single-ref profiles fail fast without retrying the same ref', async () => {
    const fake = fakeSession(['soft-throttle', 'success'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentRef: REF_A,
      session: fake.session,
      text: 'hello',
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(fake.prompted).toEqual(['hello'])
    expect(fake.setModels).toEqual([])
  })
})
