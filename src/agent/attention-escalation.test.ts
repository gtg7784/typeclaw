import { describe, expect, test } from 'bun:test'

import type { ThinkingLevel } from '@mariozechner/pi-agent-core'

import { applyTurnThinkingLevel, detectAttentionEscalation, resolveTurnThinkingLevel } from './attention-escalation'

describe('detectAttentionEscalation — positive (explicit effort)', () => {
  const escalating: readonly string[] = [
    'do it properly this time',
    'please ultrathink before answering',
    '제대로 해 주세요',
    '认真做一下',
    'ちゃんとやってください',
  ]

  for (const text of escalating) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(true)
    })
  }
})

describe('detectAttentionEscalation — positive (frustration / dissatisfaction)', () => {
  const escalating: readonly string[] = ['wtf', 'what are you doing', '뭐하는 거야', 'que merda', 'apa-apaan']

  for (const text of escalating) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(true)
    })
  }
})

describe('detectAttentionEscalation — positive (normalization)', () => {
  const escalating: readonly string[] = ['WTF', 'Ultrathink', '**제대로** 해', '`wtf`']

  for (const text of escalating) {
    test(`detects normalized: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(true)
    })
  }
})

describe('detectAttentionEscalation — negative', () => {
  const notEscalating: readonly string[] = [
    'please add a test',
    'looks good, thanks',
    '네 알겠습니다',
    '수고하셨습니다',
    'serious',
    'seriously',
    'this is a serious issue',
    'serious refactor',
    'i need serious help here',
    'a series of tests',
    '',
    'ok',
  ]

  for (const text of notEscalating) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(false)
    })
  }
})

describe('resolveTurnThinkingLevel', () => {
  test('escalation text bumps to high regardless of session default', () => {
    expect(resolveTurnThinkingLevel('wtf', 'low')).toBe('high')
    expect(resolveTurnThinkingLevel('제대로 해', undefined)).toBe('high')
  })

  test('normal text falls back to the session default', () => {
    expect(resolveTurnThinkingLevel('add a comment', 'low')).toBe('low')
  })

  test('normal text with no session default stays undefined', () => {
    expect(resolveTurnThinkingLevel('add a comment', undefined)).toBeUndefined()
  })
})

describe('applyTurnThinkingLevel', () => {
  function fakeSession() {
    const calls: ThinkingLevel[] = []
    return {
      calls,
      setThinkingLevel(level: ThinkingLevel): void {
        calls.push(level)
      },
    }
  }

  test('escalation turn sets high', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, 'ultrathink please', 'low')
    expect(session.calls).toEqual(['high'])
  })

  test('normal turn resets to the session default', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, 'add a comment', 'low')
    expect(session.calls).toEqual(['low'])
  })

  test('normal turn with no session default makes no call', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, 'add a comment', undefined)
    expect(session.calls).toEqual([])
  })

  test('escalation then normal bumps then resets', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, '뭐하는 거야', 'low')
    applyTurnThinkingLevel(session, 'thanks, looks good', 'low')
    expect(session.calls).toEqual(['high', 'low'])
  })
})
