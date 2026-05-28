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
    const text =
      '확인했습니다 ㅋㅋㅋ 지금 배포 상태는 정상이고, next step은 로그를 한 번 더 보는 거예요. 이상 있으면 바로 공유드릴게요 ㅋㅋㅋ'
    expect(checkOutboundFlood(text)).toEqual({ ok: true })
  })
})
