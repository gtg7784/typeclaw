import { describe, expect, test } from 'bun:test'

import { renderEvent } from './render'
import type { InspectEvent } from './types'

const PLAIN = { color: false }

function stripTime(line: string): string {
  return line.replace(/^\d{2}:\d{2}:\d{2}/, 'HH:MM:SS')
}

describe('renderEvent (plain, no color)', () => {
  test('meta event prints origin label', () => {
    const ev: InspectEvent = { cat: 'meta', ts: dateMs('15:08:42'), origin: { kind: 'tui' } }
    const out = renderEvent(ev, PLAIN)
    expect(stripTime(out)).toBe('HH:MM:SS  meta       origin: TUI')
  })

  test('user event prints single-line text', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'fix the\n  type error' }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  user       fix the type error')
  })

  test('tool start prints name and compact args', () => {
    const ev: InspectEvent = {
      cat: 'tool',
      ts: dateMs('15:08:43'),
      phase: 'start',
      toolCallId: 'c1',
      name: 'read',
      args: { path: 'src/auth.ts' },
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  tool ▸     read({"path":"src/auth.ts"})')
  })

  test('tool end prints name, ok status, and human duration', () => {
    const ev: InspectEvent = {
      cat: 'tool',
      ts: dateMs('15:08:44'),
      phase: 'end',
      toolCallId: 'c1',
      name: 'read',
      result: 'file contents here',
      isError: false,
      durationMs: 1234,
    }
    const out = stripTime(renderEvent(ev, PLAIN))
    expect(out).toBe('HH:MM:SS  tool ◂     read → ok "file contents here" (1.2s)')
  })

  test('tool end with isError uses error status', () => {
    const ev: InspectEvent = {
      cat: 'tool',
      ts: dateMs('15:08:44'),
      phase: 'end',
      toolCallId: 'c1',
      name: 'bash',
      isError: true,
      durationMs: 12,
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  tool ◂     bash → error (12ms)')
  })

  test('done event shows tokens and cost when present', () => {
    const ev: InspectEvent = {
      cat: 'done',
      ts: dateMs('15:08:45'),
      stopReason: 'end_turn',
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: 0.0123,
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe(
      'HH:MM:SS  done       tokens: 100 in / 50 out · $0.0123 · stop=end_turn',
    )
  })

  test('error event prints the error message', () => {
    const ev: InspectEvent = { cat: 'error', ts: dateMs('15:08:46'), message: 'provider returned 503' }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  error      provider returned 503')
  })

  test('long text is truncated with an ellipsis', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'a'.repeat(500) }
    const out = renderEvent(ev, { color: false, maxTextLength: 30 })
    expect(out).toContain('…')
    expect(stripTime(out)).toBe(`HH:MM:SS  user       ${'a'.repeat(30)}…`)
  })

  test('time anchor of 0 renders as placeholder (legacy entries without timestamp)', () => {
    const ev: InspectEvent = { cat: 'meta', ts: 0, origin: { kind: 'tui' } }
    expect(renderEvent(ev, PLAIN).startsWith('--:--:--')).toBe(true)
  })
})

describe('renderEvent (with color)', () => {
  const ANSI_ESC = String.fromCharCode(0x1b)

  test('emits ANSI codes when color enabled', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'hi' }
    const out = renderEvent(ev, { color: true })
    expect(out.includes(ANSI_ESC)).toBe(true)
  })

  test('plain mode emits zero ANSI codes', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'hi' }
    const out = renderEvent(ev, { color: false })
    expect(out.includes(ANSI_ESC)).toBe(false)
  })
})

function dateMs(hhmmss: string): number {
  const [h, m, s] = hhmmss.split(':').map(Number) as [number, number, number]
  const d = new Date()
  d.setHours(h, m, s, 0)
  return d.getTime()
}
