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
  const escalating: readonly string[] = [
    'wtf',
    'what are you doing',
    'this is fucking broken',
    'bullshit',
    'this is garbage',
    '뭐하는 거야',
    '씨발',
    '존나',
    '존나 짜증나',
    '병신같네',
    '我操',
    '卧槽',
    '草泥马',
    '我靠',
    '靠北',
    '垃圾代码',
    'くそ',
    'ふざけんな',
    'esto es una mierda',
    'que merda',
    'это бред',
    'هذا هراء',
    'apa-apaan',
    'goddamn it',
    'dammit',
  ]

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
    'abs workout',
    'great jobs',
    'position update',
    'copy the file',
    'racing game',
    'compose a message',
    'i can cut this',
    'the tabs are aligned',
    'subscribe now',
    '操作系统',
    '操作步骤',
    '草稿',
    '起草文档',
    '可靠的方案',
    '依靠',
    '废物利用很好',
    'damnation is a word',
    'scrap the old code',
    'the condemnation',
    'reassign the task',
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
  test('escalation text bumps to xhigh regardless of session default', () => {
    expect(resolveTurnThinkingLevel('wtf', 'low')).toBe('xhigh')
    expect(resolveTurnThinkingLevel('제대로 해', undefined)).toBe('xhigh')
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

  test('escalation turn sets xhigh', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, 'ultrathink please', 'low')
    expect(session.calls).toEqual(['xhigh'])
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
    expect(session.calls).toEqual(['xhigh', 'low'])
  })
})
