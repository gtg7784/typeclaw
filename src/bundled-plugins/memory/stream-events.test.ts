import { describe, expect, test } from 'bun:test'

import {
  fragmentEventSchema,
  legacyProseEventSchema,
  newEventId,
  parseEventLine,
  streamEventSchema,
  timestampFromId,
  watermarkEventSchema,
} from './stream-events'

describe('parseEventLine', () => {
  test('valid FragmentEvent parses', () => {
    const line = JSON.stringify({
      type: 'fragment',
      id: 'evt-1',
      ts: '2026-05-16T12:00:00.000Z',
      source: 'sess-1',
      entry: 'ent-1',
      topic: 'X',
      body: 'Y',
    })
    const result = parseEventLine(line)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('fragment')
    expect(result).toMatchObject({
      id: 'evt-1',
      ts: '2026-05-16T12:00:00.000Z',
      source: 'sess-1',
      entry: 'ent-1',
      topic: 'X',
      body: 'Y',
    })
  })

  test('valid WatermarkEvent parses (no topic or body required)', () => {
    const line = JSON.stringify({
      type: 'watermark',
      id: 'w-1',
      ts: '2026-05-16T12:00:00.000Z',
      source: 'sess-1',
      entry: 'ent-1',
    })
    const result = parseEventLine(line)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('watermark')
    expect(result).toMatchObject({
      id: 'w-1',
      source: 'sess-1',
      entry: 'ent-1',
    })
    expect('topic' in result!).toBe(false)
    expect('body' in result!).toBe(false)
  })

  test('LegacyProseEvent requires origin=migration', () => {
    const valid = JSON.stringify({
      type: 'legacy_prose',
      ts: '2026-05-16T12:00:00.000Z',
      text: 'old stuff',
      origin: 'migration',
    })
    expect(parseEventLine(valid)!.type).toBe('legacy_prose')

    const invalid = JSON.stringify({
      type: 'legacy_prose',
      ts: '2026-05-16T12:00:00.000Z',
      text: 'old stuff',
      origin: 'runtime',
    })
    expect(parseEventLine(invalid)).toBeNull()
  })

  test('unknown type returns null', () => {
    const line = JSON.stringify({
      type: 'mystery',
      ts: '2026-05-16T12:00:00.000Z',
    })
    expect(parseEventLine(line)).toBeNull()
  })

  test('malformed JSON returns null and does not throw', () => {
    expect(parseEventLine('{not json')).toBeNull()
    expect(parseEventLine('')).toBeNull()
  })

  test('additive fields preserved via passthrough', () => {
    const line = JSON.stringify({
      type: 'fragment',
      id: 'evt-2',
      ts: '2026-05-16T12:00:00.000Z',
      source: 'sess-1',
      entry: 'ent-1',
      topic: 'X',
      body: 'Y',
      certainty: 'explicit',
    })
    const result = parseEventLine(line)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('fragment')
    expect((result as any).certainty).toBe('explicit')
  })
})

describe('schema exports', () => {
  test('fragmentEventSchema is a passthrough zod object', () => {
    const result = fragmentEventSchema.safeParse({
      type: 'fragment',
      id: 'a',
      ts: '2026-05-16T12:00:00.000Z',
      source: 's',
      entry: 'e',
      topic: 't',
      body: 'b',
      extra: 1,
    })
    expect(result.success).toBe(true)
    expect((result.data as any).extra).toBe(1)
  })

  test('watermarkEventSchema rejects missing id', () => {
    const result = watermarkEventSchema.safeParse({
      type: 'watermark',
      ts: '2026-05-16T12:00:00.000Z',
      source: 's',
      entry: 'e',
    })
    expect(result.success).toBe(false)
  })

  test('legacyProseEventSchema rejects wrong origin', () => {
    const result = legacyProseEventSchema.safeParse({
      type: 'legacy_prose',
      ts: '2026-05-16T12:00:00.000Z',
      text: 'text',
      origin: 'other',
    })
    expect(result.success).toBe(false)
  })

  test('newEventId produces lexicographically sortable ids in append order', () => {
    const ids: string[] = []
    for (let i = 0; i < 100; i++) ids.push(newEventId())
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids)
  })

  test('newEventId returns canonical 36-char UUID with v7 version nibble', () => {
    const id = newEventId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('timestampFromId round-trips the millisecond at which the id was minted', () => {
    const before = Date.now()
    const id = newEventId()
    const after = Date.now()
    const recovered = new Date(timestampFromId(id)).getTime()
    // Bun.randomUUIDv7() and Date.now() can read slightly different clock
    // values on platforms with coarse timer granularity (observed on Windows,
    // where the UUID's embedded ms landed 1ms before the bracketing Date.now()).
    // Allow a small slack so the round-trip — recovered ≈ mint instant — is
    // asserted without depending on the two clock reads being monotonic.
    const CLOCK_SLACK_MS = 16
    expect(recovered).toBeGreaterThanOrEqual(before - CLOCK_SLACK_MS)
    expect(recovered).toBeLessThanOrEqual(after + CLOCK_SLACK_MS)
  })

  test('timestampFromId throws on shapes that are not UUIDv7-prefixed', () => {
    expect(() => timestampFromId('not-a-uuid')).toThrow()
    expect(() => timestampFromId('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toThrow()
  })

  test('streamEventSchema discriminates by type', () => {
    const fragment = streamEventSchema.safeParse({
      type: 'fragment',
      id: '1',
      ts: '2026-05-16T12:00:00.000Z',
      source: 's',
      entry: 'e',
      topic: 't',
      body: 'b',
    })
    const watermark = streamEventSchema.safeParse({
      type: 'watermark',
      id: '1',
      ts: '2026-05-16T12:00:00.000Z',
      source: 's',
      entry: 'e',
    })
    const prose = streamEventSchema.safeParse({
      type: 'legacy_prose',
      ts: '2026-05-16T12:00:00.000Z',
      text: 'text',
      origin: 'migration',
    })
    expect(fragment.success).toBe(true)
    expect(watermark.success).toBe(true)
    expect(prose.success).toBe(true)
  })
})
