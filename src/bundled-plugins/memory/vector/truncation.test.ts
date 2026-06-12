import { describe, expect, test } from 'bun:test'

import {
  boundEmbeddableText,
  estimateTokens,
  fragmentEmbeddableText,
  isOverBudget,
  TEXT_TOKEN_BUDGET,
} from './truncation'

describe('estimateTokens', () => {
  test('counts CJK characters at one token each', () => {
    const text = '안녕하세요세계'
    expect(estimateTokens(text)).toBe(text.length)
  })

  test('estimates Latin text below one token per character', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    expect(estimateTokens(text)).toBeLessThan(text.length)
    expect(estimateTokens(text)).toBeGreaterThan(0)
  })

  test('an empty string is zero tokens', () => {
    expect(estimateTokens('')).toBe(0)
  })

  test('counts at least one token per short word (char ratio alone under-counts)', () => {
    // 509 single-char words tokenize to ~509 WordPiece tokens, not ~291 by chars/3.5.
    expect(estimateTokens('a '.repeat(509))).toBeGreaterThanOrEqual(509)
  })
})

describe('isOverBudget boundary', () => {
  test('flags many short words just over the 512-token cap', () => {
    expect(isOverBudget('a '.repeat(TEXT_TOKEN_BUDGET + 1))).toBe(true)
  })
})

describe('embeddable text helpers', () => {
  test('fragmentEmbeddableText joins topic and body with a newline', () => {
    expect(fragmentEmbeddableText({ topic: 'bun preference', body: 'used bun today' })).toBe(
      'bun preference\nused bun today',
    )
  })
})

describe('isOverBudget', () => {
  test('a short canonical shard is within budget', () => {
    const compact = 'the user prefers bun over npm for this repo\n\nfragments:\n- streams/2026-06-10#abc'
    expect(isOverBudget(compact)).toBe(false)
  })

  test('a very long passage exceeds the budget', () => {
    expect(isOverBudget('word '.repeat(TEXT_TOKEN_BUDGET * 4))).toBe(true)
  })
})

describe('boundEmbeddableText', () => {
  test('leaves an in-budget string untouched and unbounded', () => {
    const text = 'a normal short belief sentence'
    const result = boundEmbeddableText(text)
    expect(result.bounded).toBe(false)
    expect(result.text).toBe(text)
  })

  test('a bounded Latin string re-estimates to at most the budget', () => {
    const long = 'word '.repeat(TEXT_TOKEN_BUDGET * 4)
    const result = boundEmbeddableText(long)
    expect(result.bounded).toBe(true)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(TEXT_TOKEN_BUDGET)
  })

  test('a bounded CJK string (1 token/char) re-estimates to at most the budget', () => {
    const long = '한'.repeat(TEXT_TOKEN_BUDGET + 200)
    const result = boundEmbeddableText(long)
    expect(result.bounded).toBe(true)
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(TEXT_TOKEN_BUDGET)
  })

  test('keeps the leading content (heading survives) when bounding a long shard', () => {
    const text = `LEADING-BELIEF-SENTENCE\n${'tail '.repeat(TEXT_TOKEN_BUDGET * 4)}`
    const result = boundEmbeddableText(text)
    expect(result.bounded).toBe(true)
    expect(result.text.startsWith('LEADING-BELIEF-SENTENCE')).toBe(true)
  })
})
