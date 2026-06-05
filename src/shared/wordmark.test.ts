import { describe, expect, test } from 'bun:test'

import { COMPACT_WORDMARK, WORDMARK_LINES, WORDMARK_WIDTH } from './wordmark'

describe('wordmark', () => {
  test('is the 6-row ANSI Shadow art', () => {
    expect(WORDMARK_LINES).toHaveLength(6)
    expect(WORDMARK_LINES[0]).toContain('█')
  })

  test('carries no ANSI escape sequences (color-agnostic source)', () => {
    for (const line of WORDMARK_LINES) {
      expect(line).not.toContain('\x1b')
    }
  })

  test('WORDMARK_WIDTH equals the widest art line', () => {
    expect(WORDMARK_WIDTH).toBe(Math.max(...WORDMARK_LINES.map((l) => l.length)))
  })

  test('preserves the trailing space on the last row (alignment-significant)', () => {
    expect(WORDMARK_LINES[WORDMARK_LINES.length - 1]!.endsWith(' ')).toBe(true)
  })

  test('compact fallback is a single plain line', () => {
    expect(COMPACT_WORDMARK).toBe('typeclaw')
    expect(COMPACT_WORDMARK).not.toContain('\n')
  })
})
