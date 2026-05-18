import { describe, expect, test } from 'bun:test'

import { createStream } from '@/stream'

import type { AdapterId } from './schema'
import { createTunnelBridge } from './tunnel-bridge'

function tunnelUrlChangedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'tunnel-url-changed',
    tunnelName: 'github-webhook',
    url: 'https://x.trycloudflare.com',
    for: { kind: 'channel', name: 'github' },
    rotatedAt: '2026-05-18T00:00:00.000Z',
    ...overrides,
  }
}

function silentLogger(): { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void } {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

describe('createTunnelBridge', () => {
  test('restarts the channel adapter for channel-owned tunnel URL changes', () => {
    const stream = createStream()
    const calls: AdapterId[] = []
    createTunnelBridge({
      stream,
      channelManager: { restartAdapter: async (name) => void calls.push(name) },
      logger: silentLogger(),
    })

    stream.publish({ target: { kind: 'broadcast' }, payload: tunnelUrlChangedPayload() })

    expect(calls).toEqual(['github'])
  })

  test('ignores manual tunnel URL changes', () => {
    const stream = createStream()
    const calls: AdapterId[] = []
    createTunnelBridge({
      stream,
      channelManager: { restartAdapter: async (name) => void calls.push(name) },
      logger: silentLogger(),
    })

    stream.publish({
      target: { kind: 'broadcast' },
      payload: tunnelUrlChangedPayload({ for: { kind: 'manual' } }),
    })

    expect(calls).toEqual([])
  })

  test('fires a restart for every rapid URL change', () => {
    const stream = createStream()
    const calls: AdapterId[] = []
    createTunnelBridge({
      stream,
      channelManager: { restartAdapter: async (name) => void calls.push(name) },
      logger: silentLogger(),
    })

    stream.publish({
      target: { kind: 'broadcast' },
      payload: tunnelUrlChangedPayload({ url: 'https://a.trycloudflare.com' }),
    })
    stream.publish({
      target: { kind: 'broadcast' },
      payload: tunnelUrlChangedPayload({ url: 'https://b.trycloudflare.com' }),
    })

    expect(calls).toEqual(['github', 'github'])
  })

  test('ignores wrong payload shapes silently', () => {
    const stream = createStream()
    const calls: AdapterId[] = []
    createTunnelBridge({
      stream,
      channelManager: { restartAdapter: async (name) => void calls.push(name) },
      logger: silentLogger(),
    })

    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'not-tunnel-url-changed' } })
    stream.publish({ target: { kind: 'broadcast' }, payload: tunnelUrlChangedPayload({ tunnelName: undefined }) })
    stream.publish({ target: { kind: 'broadcast' }, payload: tunnelUrlChangedPayload({ for: { kind: 'channel' } }) })

    expect(calls).toEqual([])
  })

  test('stop unsubscribes from broadcasts', () => {
    const stream = createStream()
    const calls: AdapterId[] = []
    const bridge = createTunnelBridge({
      stream,
      channelManager: { restartAdapter: async (name) => void calls.push(name) },
      logger: silentLogger(),
    })

    bridge.stop()
    stream.publish({ target: { kind: 'broadcast' }, payload: tunnelUrlChangedPayload() })

    expect(calls).toEqual([])
  })
})
