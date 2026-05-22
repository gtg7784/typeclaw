import { describe, expect, test } from 'bun:test'

import { matchesFilter, parseDuration, parseFilter } from './types'
import type { InspectEvent } from './types'

const sampleTool: InspectEvent = {
  cat: 'tool',
  ts: 0,
  phase: 'start',
  toolCallId: 'c1',
  name: 'read',
}
const sampleUser: InspectEvent = { cat: 'user', ts: 0, text: 'hi' }
const sampleAssistant: InspectEvent = { cat: 'assistant', ts: 0, text: 'hello' }

describe('parseFilter', () => {
  test('empty / undefined → no filter (everything passes)', () => {
    for (const input of [undefined, '', '   ']) {
      const out = parseFilter(input)
      expect(out.ok).toBe(true)
      if (!out.ok) throw new Error('unreachable')
      expect(matchesFilter(sampleTool, out.filter)).toBe(true)
      expect(matchesFilter(sampleUser, out.filter)).toBe(true)
    }
  })

  test('include list narrows to listed categories', () => {
    const out = parseFilter('tool,error')
    if (!out.ok) throw new Error('expected ok')
    expect(matchesFilter(sampleTool, out.filter)).toBe(true)
    expect(matchesFilter({ cat: 'error', ts: 0, message: 'x' }, out.filter)).toBe(true)
    expect(matchesFilter(sampleUser, out.filter)).toBe(false)
    expect(matchesFilter(sampleAssistant, out.filter)).toBe(false)
  })

  test('negation drops listed categories', () => {
    const out = parseFilter('!assistant')
    if (!out.ok) throw new Error('expected ok')
    expect(matchesFilter(sampleAssistant, out.filter)).toBe(false)
    expect(matchesFilter(sampleUser, out.filter)).toBe(true)
    expect(matchesFilter(sampleTool, out.filter)).toBe(true)
  })

  test('include + exclude combined: include wins as gate, exclude wins as veto', () => {
    const out = parseFilter('tool,user,!user')
    if (!out.ok) throw new Error('expected ok')
    expect(matchesFilter(sampleTool, out.filter)).toBe(true)
    expect(matchesFilter(sampleUser, out.filter)).toBe(false)
  })

  test('unknown category surfaces precise error', () => {
    const out = parseFilter('tool,wat')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toContain('"wat"')
    expect(out.reason).toContain('meta, user, assistant, tool, error, done')
  })

  test('case-insensitive token match', () => {
    const out = parseFilter('TOOL,!Assistant')
    if (!out.ok) throw new Error('expected ok')
    expect(matchesFilter(sampleTool, out.filter)).toBe(true)
    expect(matchesFilter(sampleAssistant, out.filter)).toBe(false)
  })
})

describe('parseDuration', () => {
  test('canonical forms', () => {
    expect(parseDuration('30s')).toEqual({ ok: true, ms: 30_000 })
    expect(parseDuration('5m')).toEqual({ ok: true, ms: 5 * 60_000 })
    expect(parseDuration('2h')).toEqual({ ok: true, ms: 2 * 3_600_000 })
    expect(parseDuration('7d')).toEqual({ ok: true, ms: 7 * 86_400_000 })
  })

  test('trims whitespace', () => {
    expect(parseDuration('  5m ')).toEqual({ ok: true, ms: 5 * 60_000 })
  })

  test('rejects malformed input with a remediation hint', () => {
    const out = parseDuration('5 minutes')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toContain('30s, 5m, 1h, 7d')
  })

  test('rejects bare numbers', () => {
    expect(parseDuration('5').ok).toBe(false)
  })

  test('rejects unknown units', () => {
    expect(parseDuration('5y').ok).toBe(false)
  })
})
