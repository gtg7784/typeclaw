import { describe, expect, test } from 'bun:test'

import { fenceRuntimeNotice } from './runtime-notice'

describe('fenceRuntimeNotice', () => {
  test('wraps body in canonical SYSTEM MESSAGE framing with horizontal-rule fences', () => {
    const out = fenceRuntimeNotice('do not reply to this')

    expect(out).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(out).toContain('do not reply to this')
    expect(out).toContain('Do not acknowledge or reply to this notice')
    expect(out).toMatch(/---\s*\n\*\*\[SYSTEM MESSAGE/)
    expect(out).toMatch(/Do not acknowledge or reply to this notice\.\*\*\s*\n---/)
  })

  test('leads with a blank-line separator so concatenation onto a base string never collides', () => {
    const baseText = 'posted to slack-bot:T0/C0: "hi"'
    const concatenated = `${baseText}${fenceRuntimeNotice('a hint')}`

    expect(concatenated.startsWith(baseText)).toBe(true)
    expect(concatenated).toMatch(/posted to slack-bot:T0\/C0: "hi"\n\n---\n/)
  })

  test('preserves the body verbatim (no trimming, no rewrapping)', () => {
    const body = '   indented body with    multiple   spaces and trailing newline\n'

    expect(fenceRuntimeNotice(body)).toContain(body)
  })

  test('shape matches the canonical loop-guard block convention documented in router.ts', () => {
    const out = fenceRuntimeNotice('any body')

    expect(out.split('---').length).toBe(3)
    expect(out.indexOf('**[SYSTEM MESSAGE')).toBeGreaterThan(out.indexOf('---'))
    expect(out.lastIndexOf('---')).toBeGreaterThan(out.indexOf('Do not acknowledge'))
  })
})
