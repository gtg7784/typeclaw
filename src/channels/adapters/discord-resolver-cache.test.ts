import { describe, expect, test } from 'bun:test'

import { DiscordResolverCache } from './discord-resolver-cache'

describe('DiscordResolverCache', () => {
  test('evicts expired entries instead of retaining dead keys', () => {
    const cache = new DiscordResolverCache<string>(2)
    cache.set('expired', 'old', 5, 0)
    cache.set('live', 'new', 20, 10)

    expect(cache.get('expired', 10)).toBeUndefined()
    expect(cache.get('live', 10)).toBe('new')
  })

  test('bounds cardinality and evicts the least recently used entry', () => {
    const cache = new DiscordResolverCache<string>(2)
    cache.set('first', 'a', 100, 0)
    cache.set('second', 'b', 100, 0)
    expect(cache.get('first', 1)).toBe('a')

    cache.set('third', 'c', 100, 1)

    expect(cache.get('second', 1)).toBeUndefined()
    expect(cache.get('first', 1)).toBe('a')
    expect(cache.get('third', 1)).toBe('c')
  })
})
