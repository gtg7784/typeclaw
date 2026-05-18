import { describe, expect, it } from 'bun:test'

import { createStream } from '@/stream'

import { createTunnelManager } from './manager'
import type { TunnelConfig, TunnelUrlChangedPayload } from './types'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

function externalConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    name: 'demo',
    provider: 'external',
    for: { kind: 'manual' },
    externalUrl: 'https://demo.example.com',
    ...overrides,
  }
}

describe('createTunnelManager (external provider)', () => {
  it('publishes a tunnel-url-changed broadcast on start', async () => {
    // given
    const stream = createStream()
    const received: TunnelUrlChangedPayload[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg.payload as TunnelUrlChangedPayload)
    })
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    // when
    await manager.start()

    // then
    expect(received).toHaveLength(1)
    expect(received[0]?.kind).toBe('tunnel-url-changed')
    expect(received[0]?.tunnelName).toBe('demo')
    expect(received[0]?.url).toBe('https://demo.example.com')
    expect(received[0]?.for).toEqual({ kind: 'manual' })
  })

  it('snapshot reports healthy after start, stopped after stop', async () => {
    const stream = createStream()
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    expect(manager.snapshot()[0]?.status).toBe('stopped')
    await manager.start()
    expect(manager.snapshot()[0]?.status).toBe('healthy')
    expect(manager.snapshot()[0]?.url).toBe('https://demo.example.com')
    await manager.stop()
    expect(manager.snapshot()[0]?.status).toBe('stopped')
  })

  it('urlFor returns the configured URL after start, null before', async () => {
    const stream = createStream()
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    expect(manager.urlFor('demo')).toBeNull()
    await manager.start()
    expect(manager.urlFor('demo')).toBe('https://demo.example.com')
    expect(manager.urlFor('unknown')).toBeNull()
  })

  it('routes the for tag through to the broadcast payload (channel kind)', async () => {
    const stream = createStream()
    const received: TunnelUrlChangedPayload[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg.payload as TunnelUrlChangedPayload)
    })
    const manager = createTunnelManager({
      tunnels: [externalConfig({ name: 'gh', for: { kind: 'channel', name: 'github' } })],
      stream,
      logger: silentLogger,
    })

    await manager.start()

    expect(received[0]?.for).toEqual({ kind: 'channel', name: 'github' })
    expect(received[0]?.tunnelName).toBe('gh')
  })

  it('publishes one broadcast per tunnel when multiple are configured', async () => {
    const stream = createStream()
    const received: TunnelUrlChangedPayload[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg.payload as TunnelUrlChangedPayload)
    })
    const manager = createTunnelManager({
      tunnels: [
        externalConfig({ name: 'a', externalUrl: 'https://a.example.com' }),
        externalConfig({ name: 'b', externalUrl: 'https://b.example.com' }),
      ],
      stream,
      logger: silentLogger,
    })

    await manager.start()

    expect(received).toHaveLength(2)
    expect(received.map((p) => p.tunnelName).sort()).toEqual(['a', 'b'])
  })

  it('rejects external tunnels missing externalUrl at provider construction', () => {
    const stream = createStream()
    expect(() =>
      createTunnelManager({
        tunnels: [externalConfig({ externalUrl: undefined })],
        stream,
        logger: silentLogger,
      }),
    ).toThrow(/externalUrl is required/)
  })

  it('start is idempotent: second start does not republish', async () => {
    const stream = createStream()
    const received: TunnelUrlChangedPayload[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg.payload as TunnelUrlChangedPayload)
    })
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    await manager.start()
    await manager.start()

    expect(received).toHaveLength(1)
  })

  it('tail returns an empty log snapshot for external tunnels and unknown names', () => {
    const stream = createStream()
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    expect(manager.tail('demo')).toEqual([])
    expect(manager.tail('unknown')).toEqual([])
  })

  it('subscribeToLogs returns an unsubscribe function for external tunnels and unknown names', () => {
    const stream = createStream()
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    expect(typeof manager.subscribeToLogs('demo', () => {})).toBe('function')
    expect(typeof manager.subscribeToLogs('unknown', () => {})).toBe('function')
  })
})
