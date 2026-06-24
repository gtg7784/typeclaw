import { describe, expect, test } from 'bun:test'

import { configSchema, type Models } from '@/config/config'
import type { KnownModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { promptWithFallback, resolveFallbackChain } from './model-fallback'

const REF_A = 'openai/gpt-5.4-nano' as KnownModelRef
const REF_B = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' as KnownModelRef
const REF_C = 'zai/glm-4.6' as KnownModelRef

function parseModels(models: Record<string, string | string[]>): Models {
  return configSchema.parse({ models }).models
}

type SessionFake = {
  ref: KnownModelRef
  prompt: (text: string) => Promise<void>
  // The subscribe field accepts the event callback shape AgentSession uses
  // for `message_end`. We hand-roll it to simulate soft-error emission
  // without standing up a real pi-coding-agent session.
  emitSoftError: (msg: string) => void
  disposed: boolean
  promptedWith: string[]
}

function fakeSession(opts: {
  ref: KnownModelRef
  behavior: 'success' | 'throw' | 'soft-error'
  errorMessage?: string
}): { session: AgentSession; fake: SessionFake } {
  const listeners: Array<(event: { type: string; message?: unknown }) => void> = []
  const fake: SessionFake = {
    ref: opts.ref,
    promptedWith: [],
    disposed: false,
    emitSoftError: (msg) => {
      for (const l of listeners) {
        l({
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: msg },
        })
      }
    },
    prompt: async (text: string) => {
      fake.promptedWith.push(text)
      if (opts.behavior === 'throw') {
        throw new Error(opts.errorMessage ?? `hard failure on ${opts.ref}`)
      }
      if (opts.behavior === 'soft-error') {
        fake.emitSoftError(opts.errorMessage ?? `soft failure on ${opts.ref}`)
      }
      // success — no event needed by the helper, the listener only fires
      // on soft errors so a clean turn looks like "prompt resolves with
      // no events observed".
    },
  }
  const session = {
    prompt: fake.prompt,
    subscribe: (cb: (event: { type: string; message?: unknown }) => void) => {
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  } as unknown as AgentSession
  return { session, fake }
}

describe('resolveFallbackChain', () => {
  test('returns single-element chain for single-ref profile', () => {
    const models = parseModels({ default: REF_A })
    expect(resolveFallbackChain(models, undefined).map(String)).toEqual([REF_A])
    expect(resolveFallbackChain(models, 'default').map(String)).toEqual([REF_A])
  })

  test('returns multi-element chain for multi-ref profile', () => {
    const models = parseModels({ default: [REF_A, REF_B, REF_C] })
    expect(resolveFallbackChain(models, undefined).map(String)).toEqual([REF_A, REF_B, REF_C])
  })

  test('falls back to default chain for unknown profile', () => {
    const models = parseModels({ default: [REF_A, REF_B] })
    expect(resolveFallbackChain(models, 'nonexistent').map(String)).toEqual([REF_A, REF_B])
  })

  test('returns the named profile chain when defined', () => {
    const models = parseModels({ default: REF_A, fast: [REF_B, REF_C] })
    expect(resolveFallbackChain(models, 'fast').map(String)).toEqual([REF_B, REF_C])
  })
})

describe('promptWithFallback', () => {
  test('returns success on the first ref when it works', async () => {
    const created: SessionFake[] = []
    const result = await promptWithFallback({
      refs: [REF_A, REF_B],
      text: 'hello',
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({ ref, behavior: 'success' })
        created.push(fake)
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_A)
    expect(result.attempts).toEqual([{ ref: REF_A, outcome: 'success' }])
    expect(created).toHaveLength(1)
    expect(created[0]!.promptedWith).toHaveLength(1)
    expect(created[0]!.promptedWith[0]).toContain('hello')
    expect(created[0]!.disposed).toBe(false)
  })

  test('falls through to the next ref when the first throws', async () => {
    const created: SessionFake[] = []
    const result = await promptWithFallback({
      refs: [REF_A, REF_B],
      text: 'hello',
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({
          ref,
          behavior: ref === REF_A ? 'throw' : 'success',
          errorMessage: 'rate limited',
        })
        created.push(fake)
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_B)
    expect(result.attempts).toEqual([
      { ref: REF_A, outcome: 'hard', errorMessage: 'rate limited' },
      { ref: REF_B, outcome: 'success' },
    ])
    expect(created).toHaveLength(2)
    expect(created[0]!.disposed).toBe(true)
    expect(created[1]!.disposed).toBe(false)
    expect(created[1]!.promptedWith).toHaveLength(1)
    expect(created[1]!.promptedWith[0]).toContain('hello')
  })

  test('falls through on a soft (stopReason: error) failure', async () => {
    const created: SessionFake[] = []
    const result = await promptWithFallback({
      refs: [REF_A, REF_B],
      text: 'hello',
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({
          ref,
          behavior: ref === REF_A ? 'soft-error' : 'success',
          errorMessage: 'billing required',
        })
        created.push(fake)
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_B)
    expect(result.attempts).toEqual([
      { ref: REF_A, outcome: 'soft', errorMessage: 'billing required' },
      { ref: REF_B, outcome: 'success' },
    ])
    expect(created[0]!.disposed).toBe(true)
    expect(created[1]!.disposed).toBe(false)
  })

  test('reports success: false when every ref in the chain fails', async () => {
    const failures: string[] = []
    const created: SessionFake[] = []
    const result = await promptWithFallback({
      refs: [REF_A, REF_B, REF_C],
      text: 'hello',
      onAttemptFailed: (attempt) => failures.push(`${attempt.outcome}:${attempt.ref}`),
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({
          ref,
          behavior: 'throw',
          errorMessage: `down: ${ref}`,
        })
        created.push(fake)
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_C)
    expect(result.attempts.map((a) => a.outcome)).toEqual(['hard', 'hard', 'hard'])
    expect(result.attempts.map((a) => a.ref)).toEqual([REF_A, REF_B, REF_C])
    expect(result.lastError?.message).toBe('down: zai/glm-4.6')
    expect(created.every((c) => c.disposed)).toBe(true)
    // onAttemptFailed fires for every non-final attempt; the final attempt
    // is reflected through the returned `success: false` instead so callers
    // don't double-log.
    expect(failures).toEqual([`hard:${REF_A}`, `hard:${REF_B}`])
  })

  test('skips fallback when a single-ref chain hard-fails (still returns success: false)', async () => {
    const result = await promptWithFallback({
      refs: [REF_A],
      text: 'hello',
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({ ref, behavior: 'throw', errorMessage: 'oops' })
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })
    expect(result.success).toBe(false)
    expect(result.attempts).toEqual([{ ref: REF_A, outcome: 'hard', errorMessage: 'oops' }])
    expect(result.lastError?.message).toBe('oops')
  })

  test('rejects an empty refs array', async () => {
    await expect(
      promptWithFallback({
        refs: [],
        text: 'hello',
        createSessionForRef: async () => {
          throw new Error('should not be called')
        },
      }),
    ).rejects.toThrow('refs[] must be non-empty')
  })

  test('preserves the prompt text across retries (no text mutation between attempts)', async () => {
    const seen: { ref: string; promptedWith: string[] }[] = []
    await promptWithFallback({
      refs: [REF_A, REF_B],
      text: 'do the thing',
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({
          ref,
          behavior: ref === REF_A ? 'throw' : 'success',
        })
        return {
          session,
          dispose: async () => {
            seen.push({ ref, promptedWith: [...fake.promptedWith] })
          },
        }
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.ref).toBe(REF_A)
    expect(seen[0]!.promptedWith).toHaveLength(1)
    expect(seen[0]!.promptedWith[0]).toContain('do the thing')
  })
})

describe('promptWithFallback shouldFailover gate', () => {
  test('advances to the next ref when the error matches shouldFailover (throttle)', async () => {
    const created: SessionFake[] = []
    const result = await promptWithFallback({
      refs: [REF_A, REF_B],
      text: 'hello',
      shouldFailover: (err) => /overloaded/i.test(err.message),
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({
          ref,
          behavior: ref === REF_A ? 'soft-error' : 'success',
          errorMessage: 'server_is_overloaded',
        })
        created.push(fake)
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_B)
    expect(created).toHaveLength(2)
  })

  test('does NOT advance when the error fails shouldFailover (billing surfaces on ref #1)', async () => {
    const created: SessionFake[] = []
    const result = await promptWithFallback({
      refs: [REF_A, REF_B],
      text: 'hello',
      shouldFailover: (err) => /overloaded/i.test(err.message),
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({ ref, behavior: 'soft-error', errorMessage: 'billing required' })
        created.push(fake)
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(result.attempts).toEqual([{ ref: REF_A, outcome: 'soft', errorMessage: 'billing required' }])
    expect(result.lastError?.message).toBe('billing required')
    // only the first session was ever created — no failover attempt
    expect(created).toHaveLength(1)
  })

  test('a non-failover hard throw also surfaces without advancing', async () => {
    const created: SessionFake[] = []
    const result = await promptWithFallback({
      refs: [REF_A, REF_B],
      text: 'hello',
      shouldFailover: (err) => /overloaded/i.test(err.message),
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({ ref, behavior: 'throw', errorMessage: 'context length exceeded' })
        created.push(fake)
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(created).toHaveLength(1)
  })

  test('without shouldFailover, advances on any error (cron behavior unchanged)', async () => {
    const created: SessionFake[] = []
    const result = await promptWithFallback({
      refs: [REF_A, REF_B],
      text: 'hello',
      createSessionForRef: async (ref) => {
        const { session, fake } = fakeSession({
          ref,
          behavior: ref === REF_A ? 'soft-error' : 'success',
          errorMessage: 'billing required',
        })
        created.push(fake)
        return { session, dispose: async () => void (fake.disposed = true) }
      },
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_B)
    expect(created).toHaveLength(2)
  })
})
