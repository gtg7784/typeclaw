import { describe, expect, test } from 'bun:test'

import { checkOutboundFlood } from './outbound-flood-filter'

describe('checkOutboundFlood — short outbound messages pass', () => {
  test('empty text passes', () => {
    expect(checkOutboundFlood('')).toEqual({ ok: true })
  })

  test('short laughter passes', () => {
    expect(checkOutboundFlood('ㅋㅋㅋ')).toEqual({ ok: true })
  })

  test('short emphatic punctuation passes', () => {
    expect(checkOutboundFlood('!!!!!!!!!!')).toEqual({ ok: true })
  })
})

describe('checkOutboundFlood — outbound flood patterns are blocked', () => {
  test('blocks the production-shaped 500x Korean laughter flood', () => {
    const result = checkOutboundFlood('ㅋ'.repeat(500))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected outbound flood')
    expect(result.reason).toMatch(/^repeated-char-run:/)
  })

  test('blocks alternating low-diversity text', () => {
    const result = checkOutboundFlood('ab'.repeat(60))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected outbound flood')
    expect(result.reason).toMatch(/^low-unique-ratio:/)
  })
})

describe('checkOutboundFlood — benign outbound messages pass', () => {
  test('long prose passes', () => {
    const text =
      'I checked the deployment logs and the service is healthy now. The earlier failure came from a transient queue timeout, so I will keep watching for another cycle.'
    expect(checkOutboundFlood(text)).toEqual({ ok: true })
  })

  test('long mixed-language reply with scattered laughter passes', () => {
    // Mixed Latin + Korean (ㅋㅋㅋ is Korean text-laughter) — the flood filter
    // must not trip on scattered laughter inside otherwise-substantive prose.
    const text =
      'Confirmed ㅋㅋㅋ the deploy is healthy now, next step은 to check the logs one more time. I will share right away if anything looks off ㅋㅋㅋ'
    expect(checkOutboundFlood(text)).toEqual({ ok: true })
  })
})
