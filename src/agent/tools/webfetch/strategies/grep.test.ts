import { describe, expect, test } from 'bun:test'

import { applyGrep, GrepError } from './grep'

const SAMPLE = `line one foo
line two
line three FOO
line four
line five FOO bar
line six`

describe('applyGrep', () => {
  test('matches case-insensitively', () => {
    const result = applyGrep(SAMPLE, { pattern: 'foo' })
    expect(result).toContain('1:line one foo')
    expect(result).toContain('3:line three FOO')
    expect(result).toContain('5:line five FOO bar')
    expect(result).toContain('Found 3 matching line(s)')
  })

  test('returns no-match message when nothing matches', () => {
    expect(applyGrep(SAMPLE, { pattern: 'zzz' })).toBe('No matches for pattern: zzz')
  })

  test('includes before/after context with the - separator', () => {
    const result = applyGrep(SAMPLE, { pattern: 'three', before: 1, after: 1 })
    expect(result).toContain('2-line two')
    expect(result).toContain('3:line three FOO')
    expect(result).toContain('4-line four')
  })

  test('separates non-contiguous match groups with --', () => {
    const result = applyGrep(SAMPLE, { pattern: 'foo' })
    expect(result).toContain('--')
  })

  test('respects limit and offset for pagination', () => {
    const first = applyGrep(SAMPLE, { pattern: 'foo', limit: 1, offset: 0 })
    expect(first).toContain('1:line one foo')
    expect(first).not.toContain('3:line three FOO')

    const second = applyGrep(SAMPLE, { pattern: 'foo', limit: 1, offset: 1 })
    expect(second).toContain('3:line three FOO')
    expect(second).not.toContain('1:line one foo')
  })

  test('throws GrepError on invalid regex', () => {
    expect(() => applyGrep(SAMPLE, { pattern: '(unclosed' })).toThrow(GrepError)
  })

  test('finds all matches in a loop without lastIndex state bleeding (PR #195 regression)', () => {
    // given many lines all containing the pattern
    const many = Array.from({ length: 20 }, (_, i) => `line ${i + 1} hit`).join('\n')

    // when grep runs (internal loop calls .test() once per line)
    const result = applyGrep(many, { pattern: 'hit', limit: 100 })

    // then every line is reported as matching
    expect(result).toContain('Found 20 matching line(s)')
    for (let i = 1; i <= 20; i++) {
      expect(result).toContain(`${i}:line ${i} hit`)
    }
  })
})
