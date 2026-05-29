import { describe, expect, test } from 'bun:test'

import { formatCommand, shellQuote } from './quote'

describe('shellQuote', () => {
  test('leaves safe tokens unquoted', () => {
    expect(shellQuote('git')).toBe('git')
    expect(shellQuote('--stat')).toBe('--stat')
    expect(shellQuote('/usr/bin/bash')).toBe('/usr/bin/bash')
  })

  test('quotes tokens with spaces', () => {
    expect(shellQuote('two words')).toBe("'two words'")
  })

  test('escapes embedded single quotes', () => {
    expect(shellQuote("can't")).toBe(`'can'\\''t'`)
  })

  test('quotes shell metacharacters', () => {
    expect(shellQuote('a|b')).toBe("'a|b'")
    expect(shellQuote('$(x)')).toBe("'$(x)'")
  })
})

describe('formatCommand', () => {
  test('joins quoted tokens with spaces', () => {
    expect(formatCommand(['bash', '-c', 'echo hi'])).toBe("bash -c 'echo hi'")
  })

  test('preserves a fully-safe argv unquoted', () => {
    expect(formatCommand(['git', 'diff', '--stat'])).toBe('git diff --stat')
  })
})
