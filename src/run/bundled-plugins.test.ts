import { describe, expect, test } from 'bun:test'

import { BUNDLED_PLUGINS } from './bundled-plugins'

describe('BUNDLED_PLUGINS', () => {
  test('contains exactly the five expected plugins in hook-precedence order', () => {
    // Order is load-bearing: `security` must run before `guard` so its
    // `tool.before` hook gets first refusal on overlapping policy. `memory`
    // must run before `backup` because dreaming commits memory snapshots
    // and any future overlap on git lock contention should be resolved in
    // memory's favor (memory commits are smaller and more frequent). See the
    // header comment in bundled-plugins.ts.
    expect(BUNDLED_PLUGINS.map((p) => p.name)).toEqual(['security', 'guard', 'memory', 'backup', 'agent-browser'])
  })
})
