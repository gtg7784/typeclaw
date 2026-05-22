import { describe, expect, test } from 'bun:test'

import { LiveSessionRegistry } from './live-sessions'

const fakeSession = { subscribe: () => () => {} }

describe('LiveSessionRegistry', () => {
  test('register / get / unregister round-trip', () => {
    const reg = new LiveSessionRegistry()
    reg.register({ sessionId: 'ses_a', session: fakeSession })
    expect(reg.has('ses_a')).toBe(true)
    expect(reg.get('ses_a')?.sessionId).toBe('ses_a')
    reg.unregister('ses_a')
    expect(reg.has('ses_a')).toBe(false)
  })

  test('register is idempotent on the same id (overwrites session ref)', () => {
    const reg = new LiveSessionRegistry()
    const s1 = { subscribe: () => () => {} }
    const s2 = { subscribe: () => () => {} }
    reg.register({ sessionId: 'ses_a', session: s1 })
    reg.register({ sessionId: 'ses_a', session: s2 })
    expect(reg.size()).toBe(1)
    expect(reg.get('ses_a')?.session).toBe(s2)
  })

  test('get on missing id returns undefined', () => {
    const reg = new LiveSessionRegistry()
    expect(reg.get('ses_zzz')).toBeUndefined()
  })

  test('unregister on missing id is a no-op', () => {
    const reg = new LiveSessionRegistry()
    expect(() => reg.unregister('ses_nope')).not.toThrow()
  })

  test('clear empties the registry', () => {
    const reg = new LiveSessionRegistry()
    reg.register({ sessionId: 'ses_a', session: fakeSession })
    reg.register({ sessionId: 'ses_b', session: fakeSession })
    expect(reg.size()).toBe(2)
    reg.clear()
    expect(reg.size()).toBe(0)
  })
})
