import { describe, expect, test } from 'bun:test'

import { colorize, supportsColor } from './log-colors'

// ANSI escapes are control characters by definition; we're testing for them.
/* eslint-disable no-control-regex */
const ANSI_RE = /\u001B\[\d+m/g
// Captures the tint-color escape that wraps the line body. With a timestamp,
// it's the second ANSI sequence (after `\u001B[2m...\u001B[0m`); without one
// it's the first.
const LEADING_TINT_RE = /^(?:\u001B\[2m\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\u001B\[0m)?(\u001B\[\d+m)/
/* eslint-enable no-control-regex */

const DIM = '\u001B[2m'
const RESET = '\u001B[0m'

function strip(s: string): string {
  return s.replace(ANSI_RE, '')
}

function extractLineTint(colored: string): string {
  return LEADING_TINT_RE.exec(colored)?.[1] ?? ''
}

describe('colorize - useColor=false', () => {
  test('returns the input verbatim regardless of content', () => {
    const samples = [
      '',
      'plain text',
      '2026-05-13 11:12:01 [plugin:memory] memory-logger spawn 019e1ae9-fa33-725b-a30d-fb466c419c9c reason=idle',
      'session 019e1f1b-9a3e-7019-ad92-30a0b4be99d1: open',
    ]
    for (const s of samples) {
      expect(colorize(s, false)).toBe(s)
    }
  })

  test('emits zero ANSI escapes when useColor is false', () => {
    const out = colorize('2026-05-13 11:12:01 [plugin:memory] memory-logger done elapsed_ms=147760', false)
    expect(out).not.toContain('\x1b[')
  })
})

describe('colorize - useColor=true', () => {
  test('stripping ANSI yields the original line (mutation check)', () => {
    const lines = [
      '2026-05-13 11:12:01 [plugin:memory] memory-logger spawn 019e1ae9 reason=idle',
      '2026-05-13 11:12:43 session 019e1f1b: open',
      '2026-05-13 11:14:28 [plugin:memory] [memory-logger] done elapsed_ms=147760',
      'plain untimestamped line',
      '2026-05-13 11:12:01 untagged-but-timestamped line',
    ]
    for (const line of lines) {
      expect(strip(colorize(line, true))).toBe(line)
    }
  })

  test('dims the leading YYYY-MM-DD HH:MM:SS timestamp', () => {
    const out = colorize('2026-05-13 11:12:01 hello', true)
    expect(out.startsWith(`${DIM}2026-05-13 11:12:01${RESET}`)).toBe(true)
  })

  test('does not touch a date that appears mid-line (anchored regex)', () => {
    const out = colorize('plain 2026-05-13 11:12:01 mid-line', true)
    expect(out).toBe('plain 2026-05-13 11:12:01 mid-line')
  })

  test('tints the entire line body when a [tag] is present', () => {
    const out = colorize('2026-05-13 11:12:01 [plugin:memory] hello world', true)
    const tint = extractLineTint(out)
    expect(tint).not.toBe('')
    expect(tint).not.toBe(DIM)
    expect(out.endsWith(`${RESET}`)).toBe(true)
    expect(out).toContain(`${tint} [plugin:memory] hello world${RESET}`)
  })

  test('tags after the timestamp use the SAME color for the same name across lines', () => {
    const a = colorize('2026-05-13 11:12:01 [plugin:memory] one', true)
    const b = colorize('2026-05-13 11:13:00 [plugin:memory] two', true)
    expect(extractLineTint(a)).toBe(extractLineTint(b))
  })

  test('different tag names exercise more than one palette color', () => {
    // 10-entry palette: pairwise inequality would be flaky, so we verify the
    // distribution (set size > 1) instead.
    const names = ['plugin:memory', 'memory-logger', 'plugin:slack', 'cron', 'router', 'session', 'host', 'broker']
    const tints = new Set(names.map((n) => extractLineTint(colorize(`2026-05-13 11:12:01 [${n}] x`, true))))
    expect(tints.size).toBeGreaterThan(1)
  })

  test('uses the FIRST tag for the tint when multiple tags appear', () => {
    const first = colorize('2026-05-13 11:12:01 [plugin:memory] [memory-logger] x', true)
    const onlyFirst = colorize('2026-05-13 11:12:01 [plugin:memory] x', true)
    expect(extractLineTint(first)).toBe(extractLineTint(onlyFirst))
  })

  test('lines without a [tag] get only the timestamp dim, no body tint', () => {
    const out = colorize('2026-05-13 11:12:01 session 019e1f1b: open', true)
    expect(out).toBe(`${DIM}2026-05-13 11:12:01${RESET} session 019e1f1b: open`)
  })

  test('untimestamped untagged lines pass through unchanged', () => {
    expect(colorize('plain log output', true)).toBe('plain log output')
  })
})

describe('supportsColor', () => {
  test('returns false for a non-TTY stream', () => {
    const stream = { isTTY: false } as unknown as NodeJS.WritableStream
    expect(supportsColor(stream)).toBe(false)
  })

  test('returns true for a TTY stream when NO_COLOR is unset', () => {
    const prev = process.env.NO_COLOR
    delete process.env.NO_COLOR
    try {
      const stream = { isTTY: true } as unknown as NodeJS.WritableStream
      expect(supportsColor(stream)).toBe(true)
    } finally {
      if (prev !== undefined) process.env.NO_COLOR = prev
    }
  })

  test('returns false for a TTY stream when NO_COLOR is set non-empty', () => {
    const prev = process.env.NO_COLOR
    process.env.NO_COLOR = '1'
    try {
      const stream = { isTTY: true } as unknown as NodeJS.WritableStream
      expect(supportsColor(stream)).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = prev
    }
  })

  test('treats empty NO_COLOR the same as unset (per spec)', () => {
    const prev = process.env.NO_COLOR
    process.env.NO_COLOR = ''
    try {
      const stream = { isTTY: true } as unknown as NodeJS.WritableStream
      expect(supportsColor(stream)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = prev
    }
  })
})
