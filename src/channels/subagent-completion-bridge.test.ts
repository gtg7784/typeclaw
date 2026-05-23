import { describe, expect, test } from 'bun:test'

import { createStream } from '@/stream'

import type { ChannelRouter } from './router'
import { createSubagentCompletionBridge } from './subagent-completion-bridge'

type Injection = Parameters<ChannelRouter['injectSubagentCompletionReminder']>[0]

function fakeRouter(): {
  router: Pick<ChannelRouter, 'injectSubagentCompletionReminder'>
  calls: Injection[]
  setOutcome: (outcome: ReturnType<ChannelRouter['injectSubagentCompletionReminder']>) => void
} {
  const calls: Injection[] = []
  let outcome: ReturnType<ChannelRouter['injectSubagentCompletionReminder']> = {
    kind: 'delivered',
    keyId: 'discord-bot|g1|c1|',
  }
  return {
    router: {
      injectSubagentCompletionReminder: (args) => {
        calls.push(args)
        return outcome
      },
    },
    calls,
    setOutcome: (o) => {
      outcome = o
    },
  }
}

describe('createSubagentCompletionBridge', () => {
  test('subagent.completed broadcast → injectSubagentCompletionReminder call with same fields', () => {
    const stream = createStream()
    const { router, calls } = fakeRouter()
    createSubagentCompletionBridge({ stream, router })

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_xyz',
        subagent: 'explorer',
        parentSessionId: 'ses_abc',
        ok: true,
        durationMs: 5_000,
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      taskId: 'bg_xyz',
      subagent: 'explorer',
      parentSessionId: 'ses_abc',
      ok: true,
      durationMs: 5_000,
    })
  })

  test('failed-completion broadcast forwards the error field', () => {
    const stream = createStream()
    const { router, calls } = fakeRouter()
    createSubagentCompletionBridge({ stream, router })

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_err',
        subagent: 'scout',
        parentSessionId: 'ses_abc',
        ok: false,
        durationMs: 1_500,
        error: 'provider rate limit',
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.ok).toBe(false)
    expect(calls[0]?.error).toBe('provider rate limit')
  })

  test('non-subagent broadcasts are ignored', () => {
    const stream = createStream()
    const { router, calls } = fakeRouter()
    createSubagentCompletionBridge({ stream, router })

    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'noise' } })
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'tunnel-url-changed' } })

    expect(calls).toHaveLength(0)
  })

  test('no-live-session outcome logs an info line (debuggable drop), no throw', () => {
    const stream = createStream()
    const { router, setOutcome } = fakeRouter()
    setOutcome({ kind: 'no-live-session' })
    const logs: string[] = []
    createSubagentCompletionBridge({
      stream,
      router,
      logger: {
        info: (msg) => logs.push(`info:${msg}`),
        warn: (msg) => logs.push(`warn:${msg}`),
      },
    })

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_xyz',
        subagent: 'explorer',
        parentSessionId: 'ses_gone',
        ok: true,
        durationMs: 100,
      },
    })

    expect(logs.some((l) => l.includes('subagent-completion reminder dropped'))).toBe(true)
    expect(logs.some((l) => l.includes('ses_gone'))).toBe(true)
  })

  test('stop() unsubscribes — subsequent broadcasts are not forwarded', () => {
    const stream = createStream()
    const { router, calls } = fakeRouter()
    const bridge = createSubagentCompletionBridge({ stream, router })

    bridge.stop()

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_xyz',
        subagent: 'explorer',
        parentSessionId: 'ses_abc',
        ok: true,
        durationMs: 100,
      },
    })
    expect(calls).toHaveLength(0)
  })
})
