import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { hostLocaleIsCjk } from './host-locale'

const LOCALE_ENV_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const

describe('hostLocaleIsCjk', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const key of LOCALE_ENV_VARS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of LOCALE_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  test.each(['ja_JP.UTF-8', 'ko_KR', 'zh-Hans', 'zh_CN.UTF-8', 'ja'])('detects CJK locale %p via LANG', (value) => {
    process.env.LANG = value
    expect(hostLocaleIsCjk()).toBe(true)
  })

  test.each(['en_US.UTF-8', 'de_DE', 'fr', 'pt_BR.UTF-8'])('treats non-CJK locale %p as non-CJK', (value) => {
    process.env.LANG = value
    expect(hostLocaleIsCjk()).toBe(false)
  })

  test('C locale is treated as non-CJK without falling through to Intl', () => {
    process.env.LANG = 'C'
    expect(hostLocaleIsCjk()).toBe(false)
  })

  test('POSIX locale is treated as non-CJK', () => {
    process.env.LANG = 'POSIX'
    expect(hostLocaleIsCjk()).toBe(false)
  })

  test('LC_ALL overrides LANG (POSIX precedence)', () => {
    process.env.LC_ALL = 'ja_JP.UTF-8'
    process.env.LANG = 'en_US.UTF-8'
    expect(hostLocaleIsCjk()).toBe(true)
  })

  test('LC_CTYPE overrides LANG when LC_ALL is unset', () => {
    process.env.LC_CTYPE = 'ko_KR.UTF-8'
    process.env.LANG = 'en_US.UTF-8'
    expect(hostLocaleIsCjk()).toBe(true)
  })

  test('empty LC_ALL falls through to LANG rather than short-circuiting', () => {
    process.env.LC_ALL = ''
    process.env.LANG = 'zh_CN.UTF-8'
    expect(hostLocaleIsCjk()).toBe(true)
  })
})
