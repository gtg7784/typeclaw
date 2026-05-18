import { describe, expect, it } from 'bun:test'

import { isTunnelUrlChangedPayload } from './events'

describe('isTunnelUrlChangedPayload', () => {
  it('accepts a well-formed payload with manual for', () => {
    expect(
      isTunnelUrlChangedPayload({
        kind: 'tunnel-url-changed',
        tunnelName: 'demo',
        url: 'https://demo.example.com',
        for: { kind: 'manual' },
        rotatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(true)
  })

  it('accepts a well-formed payload with channel for', () => {
    expect(
      isTunnelUrlChangedPayload({
        kind: 'tunnel-url-changed',
        tunnelName: 'gh',
        url: 'https://x.trycloudflare.com',
        for: { kind: 'channel', name: 'github' },
        rotatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(true)
  })

  it('rejects non-object inputs', () => {
    expect(isTunnelUrlChangedPayload(null)).toBe(false)
    expect(isTunnelUrlChangedPayload(undefined)).toBe(false)
    expect(isTunnelUrlChangedPayload('hello')).toBe(false)
    expect(isTunnelUrlChangedPayload(42)).toBe(false)
  })

  it('rejects payloads with wrong kind', () => {
    expect(
      isTunnelUrlChangedPayload({
        kind: 'tunnel-down',
        tunnelName: 'demo',
        url: 'https://demo.example.com',
        for: { kind: 'manual' },
        rotatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(false)
  })

  it('rejects payloads missing required string fields', () => {
    const valid = {
      kind: 'tunnel-url-changed',
      tunnelName: 'demo',
      url: 'https://demo.example.com',
      for: { kind: 'manual' },
      rotatedAt: '2026-01-01T00:00:00.000Z',
    }
    for (const field of ['tunnelName', 'url', 'rotatedAt'] as const) {
      const broken = { ...valid, [field]: undefined }
      expect(isTunnelUrlChangedPayload(broken)).toBe(false)
    }
  })

  it('rejects payloads with malformed for', () => {
    const base = {
      kind: 'tunnel-url-changed',
      tunnelName: 'demo',
      url: 'https://demo.example.com',
      rotatedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(isTunnelUrlChangedPayload({ ...base, for: null })).toBe(false)
    expect(isTunnelUrlChangedPayload({ ...base, for: { kind: 'bogus' } })).toBe(false)
    expect(isTunnelUrlChangedPayload({ ...base, for: 'manual' })).toBe(false)
  })
})
