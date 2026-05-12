import { describe, expect, test } from 'bun:test'

import { BUNDLED_PLUGINS } from './bundled-plugins'

describe('BUNDLED_PLUGINS', () => {
  test('contains exactly the four expected plugins in hook-precedence order', () => {
    // Order is load-bearing: `security` must run before `guard` so its
    // `tool.before` hook gets first refusal on overlapping policy. See the
    // header comment in bundled-plugins.ts.
    expect(BUNDLED_PLUGINS.map((p) => p.name)).toEqual(['security', 'guard', 'memory', 'agent-browser'])
  })
})
