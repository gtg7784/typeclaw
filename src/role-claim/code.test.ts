import { describe, expect, test } from 'bun:test'

import { CLAIM_CODE_PREFIX, extractClaimCode, generateClaimCode, normalizeClaimCode } from './code'

describe('generateClaimCode', () => {
  test('emits the canonical shape', () => {
    const code = generateClaimCode()
    expect(code).toMatch(/^claim-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/)
  })

  test('is statistically unique across many invocations', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(generateClaimCode())
    expect(seen.size).toBe(100)
  })

  test('starts with the documented prefix', () => {
    expect(generateClaimCode().startsWith(CLAIM_CODE_PREFIX)).toBe(true)
  })
})

describe('extractClaimCode', () => {
  test('extracts a bare code', () => {
    expect(extractClaimCode('claim-7K9M-2X3R')).toBe('claim-7K9M-2X3R')
  })

  test('extracts with surrounding text', () => {
    expect(extractClaimCode('here you go: claim-7K9M-2X3R!')).toBe('claim-7K9M-2X3R')
  })

  test('extracts from backticks/quotes', () => {
    expect(extractClaimCode('`claim-7K9M-2X3R`')).toBe('claim-7K9M-2X3R')
    expect(extractClaimCode('"claim-7K9M-2X3R"')).toBe('claim-7K9M-2X3R')
  })

  test('normalizes lowercase to uppercase', () => {
    expect(extractClaimCode('claim-7k9m-2x3r')).toBe('claim-7K9M-2X3R')
  })

  test('returns null for no match', () => {
    expect(extractClaimCode('hello there')).toBeNull()
    expect(extractClaimCode('claim-toolong-2x3r')).toBeNull()
    expect(extractClaimCode('claim-7K9M')).toBeNull()
  })
})

describe('normalizeClaimCode', () => {
  test('uppercases the body, preserves prefix', () => {
    expect(normalizeClaimCode('claim-abcd-1234')).toBe('claim-ABCD-1234')
  })

  test('trims whitespace', () => {
    expect(normalizeClaimCode('  claim-ABCD-1234  ')).toBe('claim-ABCD-1234')
  })
})
