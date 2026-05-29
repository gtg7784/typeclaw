import { describe, expect, test } from 'bun:test'

import { fenceRuntimeNotice, fenceToolResult } from './runtime-notice'

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

describe('fenceToolResult', () => {
  test('begins with the fence opener so no echoed prose can lead the result', () => {
    const out = fenceToolResult('posted to slack-bot:T0/C0: "You\'re welcome!"')

    expect(out.startsWith('---\n**[SYSTEM MESSAGE — not from a human]**')).toBe(true)
  })

  test('places the receipt inside the fence and labels it as the model\u2019s own output', () => {
    const receipt = 'posted to slack-bot:T0/C0: "thanks!"'
    const out = fenceToolResult(receipt)

    expect(out).toContain(receipt)
    expect(out.indexOf(receipt)).toBeGreaterThan(out.indexOf('**[SYSTEM MESSAGE'))
    expect(out).toContain('your OWN already-delivered message')
    expect(out).toContain('Do not acknowledge or reply to it')
  })

  test('closes with a horizontal-rule fence (three rules total, like the loop-guard block)', () => {
    const out = fenceToolResult('any receipt')

    expect(out.split('---').length).toBe(3)
    expect(out.trimEnd().endsWith('---')).toBe(true)
  })
})
