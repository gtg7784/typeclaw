import { describe, expect, it } from 'bun:test'

import { crossScriptMarginScale, dominantScript } from './script'

describe('dominantScript', () => {
  it('classifies Latin text', () => {
    expect(dominantScript('docker cannot read proc filesystem')).toBe('latin')
  })

  it('classifies Korean (Hangul) text', () => {
    expect(
      dominantScript(
        '\uC0CC\uB4DC\uBC15\uC2A4\uC5D0\uC11C proc \uD30C\uC77C\uC2DC\uC2A4\uD15C\uC744 \uC77D\uC9C0 \uBABB\uD558\uB294 \uBB38\uC81C',
      ),
    ).toBe('cjk')
  })

  it('classifies Japanese (Kana) text', () => {
    expect(dominantScript('\u30B5\u30F3\u30C9\u30DC\u30C3\u30AF\u30B9\u3067proc\u3092\u8AAD\u3081\u306A\u3044')).toBe(
      'cjk',
    )
  })

  it('classifies Chinese (Han) text', () => {
    expect(dominantScript('\u9632\u6B62\u4E24\u4E2A\u673A\u5668\u4EBA\u4E92\u76F8\u65E0\u9650\u56DE\u590D')).toBe('cjk')
  })

  it('classifies Cyrillic text', () => {
    expect(
      dominantScript(
        '\u043F\u0440\u0435\u0434\u043E\u0442\u0432\u0440\u0430\u0442\u0438\u0442\u044C \u0431\u0435\u0441\u043A\u043E\u043D\u0435\u0447\u043D\u044B\u0439 \u0446\u0438\u043A\u043B',
      ),
    ).toBe('cyrillic')
  })

  it('classifies Arabic text', () => {
    expect(
      dominantScript(
        '\u0645\u0646\u0639 \u0627\u0644\u062D\u0644\u0642\u0629 \u0627\u0644\u0644\u0627\u0646\u0647\u0627\u0626\u064A\u0629',
      ),
    ).toBe('arabic')
  })

  it('returns the dominant script for mixed text by majority of script-bearing chars', () => {
    // mostly Korean prose with a couple of English keyword anchors -> CJK dominant
    expect(
      dominantScript(
        'Discord \uBD07 \uBD84\uB958\uC5D0\uC11C peer bot \uBB34\uD55C \uB8E8\uD504\uB97C \uB9C9\uB294 \uBC29\uBC95',
      ),
    ).toBe('cjk')
  })

  it('treats whitespace/punctuation/digits as script-neutral (does not flip the verdict)', () => {
    expect(dominantScript('PR #1054 \u2014 \uBD07 \uBD84\uB958 (peer bot) \uBB34\uD55C \uB8E8\uD504')).toBe('cjk')
  })

  it('falls back to latin for purely neutral input (digits/punctuation only)', () => {
    expect(dominantScript('#1054 / 2026-06-24')).toBe('latin')
  })
})

describe('crossScriptMarginScale', () => {
  it('returns 1 (strict, unchanged margin) when the query shares the candidate band script', () => {
    expect(crossScriptMarginScale('latin', ['latin', 'latin', 'latin'])).toBe(1)
  })

  it('returns 1 when no candidate scripts are known (cannot establish a mismatch)', () => {
    expect(crossScriptMarginScale('cjk', [])).toBe(1)
  })

  it('loosens the margin (scale < 1) for a cross-script query vs a same-script band', () => {
    const scale = crossScriptMarginScale('cjk', ['latin', 'latin', 'latin', 'latin'])
    expect(scale).toBeGreaterThan(0)
    expect(scale).toBeLessThan(1)
  })

  it('is symmetric: English query vs an all-Korean band loosens equally', () => {
    const enVsKo = crossScriptMarginScale('latin', ['cjk', 'cjk', 'cjk', 'cjk'])
    const koVsEn = crossScriptMarginScale('cjk', ['latin', 'latin', 'latin', 'latin'])
    expect(enVsKo).toBe(koVsEn)
  })

  it('stays strict when the query script is present in the candidate band (partial match)', () => {
    expect(crossScriptMarginScale('cjk', ['cjk', 'latin', 'latin'])).toBe(1)
  })
})
