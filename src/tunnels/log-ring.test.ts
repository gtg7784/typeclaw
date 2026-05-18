import { describe, expect, it } from 'bun:test'

import { createLogRing } from './log-ring'

describe('createLogRing', () => {
  it('stores appended lines in insertion order', () => {
    const ring = createLogRing({ maxBytes: 100 })

    ring.append('first')
    ring.append('second')

    expect(ring.snapshot()).toEqual(['first', 'second'])
  })

  it('drops the oldest lines first when the byte cap is exceeded', () => {
    const ring = createLogRing({ maxBytes: 6 })

    ring.append('abc')
    ring.append('de')
    ring.append('fg')

    expect(ring.snapshot()).toEqual(['de', 'fg'])
  })

  it('counts bytes rather than UTF-16 code units', () => {
    const ring = createLogRing({ maxBytes: 4 })

    ring.append('é')
    ring.append('한')

    expect(ring.snapshot()).toEqual(['한'])
  })

  it('keeps an oversized newest line instead of dropping every line', () => {
    const ring = createLogRing({ maxBytes: 3 })

    ring.append('old')
    ring.append('newest')

    expect(ring.snapshot()).toEqual(['newest'])
  })

  it('snapshot returns a copy', () => {
    const ring = createLogRing({ maxBytes: 100 })
    ring.append('line')

    const snapshot = ring.snapshot()
    snapshot.push('mutated')

    expect(ring.snapshot()).toEqual(['line'])
  })

  it('subscribers receive future lines only', () => {
    const ring = createLogRing({ maxBytes: 100 })
    ring.append('before')
    const received: string[] = []

    ring.subscribe((line) => received.push(line))
    ring.append('after')

    expect(received).toEqual(['after'])
  })

  it('unsubscribe removes only that subscriber', () => {
    const ring = createLogRing({ maxBytes: 100 })
    const a: string[] = []
    const b: string[] = []

    const unsubscribeA = ring.subscribe((line) => a.push(line))
    ring.subscribe((line) => b.push(line))
    ring.append('one')
    unsubscribeA()
    ring.append('two')

    expect(a).toEqual(['one'])
    expect(b).toEqual(['one', 'two'])
  })

  it('rejects non-positive byte caps', () => {
    expect(() => createLogRing({ maxBytes: 0 })).toThrow(/positive integer/)
  })
})
