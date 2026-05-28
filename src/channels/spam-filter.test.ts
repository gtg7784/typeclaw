import { describe, expect, test } from 'bun:test'

import { checkSpam } from './spam-filter'

describe('checkSpam — short messages always pass', () => {
  test('empty string passes', () => {
    expect(checkSpam('')).toEqual({ ok: true })
  })

  test('one-liner Korean laughter passes', () => {
    expect(checkSpam('ㅋㅋㅋ')).toEqual({ ok: true })
  })

  test('enthusiastic but short laughter passes', () => {
    expect(checkSpam('ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ')).toEqual({ ok: true })
  })

  test('short emphatic punctuation passes', () => {
    expect(checkSpam('!!!!!!!!!!')).toEqual({ ok: true })
  })

  test('short English chatter passes', () => {
    expect(checkSpam('lol that was wild')).toEqual({ ok: true })
  })
})

describe('checkSpam — flood patterns are blocked', () => {
  test('production case: 500x ㅋ is blocked by repeated-char-run', () => {
    const result = checkSpam('ㅋ'.repeat(500))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/^repeated-char-run:/)
  })

  test('40x ㅋ on the edge of MIN_LENGTH is blocked', () => {
    const result = checkSpam('ㅋ'.repeat(40))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/^repeated-char-run:40$/)
  })

  test('Latin character flood is blocked', () => {
    const result = checkSpam('a'.repeat(100))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/^repeated-char-run:/)
  })

  test('emoji flood is blocked', () => {
    const result = checkSpam('🤣'.repeat(60))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/^repeated-char-run:/)
  })

  test('precomposed Korean syllable repetition is blocked', () => {
    const result = checkSpam('크'.repeat(80))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/^repeated-char-run:/)
  })

  test('alternating two characters with low diversity is blocked', () => {
    const result = checkSpam('ab'.repeat(60))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/^low-unique-ratio:/)
  })

  test('character dominance is blocked even when runs are broken up', () => {
    // 'a' interleaved with rotating chars: no run >2, but ~90% are 'a'.
    const filler = 'bcdefghij'
    let text = ''
    for (let i = 0; i < 100; i++) text += 'aa' + filler[i % filler.length]
    const result = checkSpam(text)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/^(char-dominance|low-unique-ratio):/)
  })
})

describe('checkSpam — long benign messages pass', () => {
  test('long English sentence passes', () => {
    const text =
      'I think the new release dropped this morning, which is great timing because we still need to coordinate with the platform team about the upgrade window and rollback plan.'
    expect(checkSpam(text)).toEqual({ ok: true })
  })

  test('long Korean sentence with natural ㅋㅋㅋ scattered passes', () => {
    const text =
      '오늘 회의에서 결정된 내용 정리해서 공유드릴게요 ㅋㅋㅋ 다음주 배포 일정도 같이 확인 부탁드려요 ㅋㅋㅋ 그리고 새로 들어온 이슈 우선순위도 한번 봐주시면 감사하겠습니다'
    expect(checkSpam(text)).toEqual({ ok: true })
  })

  test('mixed-language paragraph passes', () => {
    const text =
      'Latest 빌드 is failing on CI — looks like a flaky 테스트 in the channel router. PR #1234 should fix it once review is done.'
    expect(checkSpam(text)).toEqual({ ok: true })
  })

  test('code snippet with repeated tokens passes', () => {
    const text = 'function foo(a, b, c, d, e, f) { return a + b + c + d + e + f; }'
    expect(checkSpam(text)).toEqual({ ok: true })
  })
})

describe('checkSpam — Unicode normalisation', () => {
  test('compatibility jamo and initial jamo collapse to the same run', () => {
    const compat = '\u314b'.repeat(40)
    const initial = '\u110f'.repeat(40)
    expect(checkSpam(compat).ok).toBe(false)
    expect(checkSpam(initial).ok).toBe(false)
  })
})
