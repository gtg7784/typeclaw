import { describe, expect, test } from 'bun:test'

import { createStream } from '@/stream'

import { createPrVerdictActivityBridge } from './pr-verdict-activity-bridge'
import type { ChannelRouter } from './router'

type Injection = Parameters<ChannelRouter['injectPrVerdictActivity']>[0]

function fakeRouter(): {
  router: Pick<ChannelRouter, 'injectPrVerdictActivity'>
  calls: Injection[]
} {
  const calls: Injection[] = []
  return {
    router: {
      injectPrVerdictActivity: (args) => {
        calls.push(args)
        return { kind: 'delivered', count: 1 }
      },
    },
    calls,
  }
}

describe('createPrVerdictActivityBridge', () => {
  test('pr.verdict-activity broadcast → injectPrVerdictActivity call with same fields', () => {
    const stream = createStream()
    const { router, calls } = fakeRouter()
    createPrVerdictActivityBridge({ stream, router })

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'pr.verdict-activity',
        workspace: 'typeclaw/typeclaw',
        prNumber: 1042,
        verdict: 'APPROVE',
        sessionId: 'ses_pub',
      },
    })

    expect(calls).toEqual([
      { workspace: 'typeclaw/typeclaw', prNumber: 1042, verdict: 'APPROVE', sessionId: 'ses_pub' },
    ])
  })

  test('ignores unrelated broadcast payloads', () => {
    const stream = createStream()
    const { router, calls } = fakeRouter()
    createPrVerdictActivityBridge({ stream, router })

    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'subagent.completed', parentSessionId: 'x' } })
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'tunnel-url-changed' } })
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'pr.verdict-activity', workspace: 'a/b' } })

    expect(calls).toHaveLength(0)
  })

  test('stop() unsubscribes so later broadcasts are not routed', () => {
    const stream = createStream()
    const { router, calls } = fakeRouter()
    const bridge = createPrVerdictActivityBridge({ stream, router })
    bridge.stop()

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'pr.verdict-activity',
        workspace: 'typeclaw/typeclaw',
        prNumber: 1042,
        verdict: 'REQUEST_CHANGES',
        sessionId: 'ses_pub',
      },
    })

    expect(calls).toHaveLength(0)
  })
})
