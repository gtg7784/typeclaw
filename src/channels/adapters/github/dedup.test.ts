import { describe, expect, it } from 'bun:test'

import { createDeliveryDedup } from './dedup'

describe('createDeliveryDedup', () => {
  it('keeps recent deliveries and evicts least-recently inserted ids', () => {
    const dedup = createDeliveryDedup(2)
    dedup.add('a')
    dedup.add('b')
    expect(dedup.has('a')).toBe(true)
    dedup.add('c')
    expect(dedup.has('a')).toBe(false)
    expect(dedup.has('b')).toBe(true)
    expect(dedup.has('c')).toBe(true)
    expect(dedup.size()).toBe(2)
  })
})
