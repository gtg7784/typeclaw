import { describe, expect, test } from 'bun:test'

import { buildInjectionPlan, DEFAULT_INJECTION_BUDGET_BYTES } from './injection-plan'
import type { TopicShard } from './load-shards'

function shard(slug: string, bodyBytes: number): TopicShard {
  return {
    path: `/tmp/agent/memory/topics/${slug}.md`,
    slug,
    frontmatter: { heading: slug, cites: 1, days: 1, lastReinforced: '2026-05-16' },
    body: 'x'.repeat(bodyBytes),
  }
}

describe('buildInjectionPlan', () => {
  test('returns direct mode when total body bytes are at or below the budget', () => {
    const shards = [shard('a', 1000), shard('b', 1000), shard('c', 2000)]
    const plan = buildInjectionPlan(shards, { budgetBytes: 16384 })
    expect(plan.mode).toBe('direct')
    expect(plan.shards).toBe(shards)
  })

  test('returns index mode when total body bytes exceed the budget', () => {
    const shards = Array.from({ length: 20 }, (_, i) => shard(`s${i}`, 2000))
    const plan = buildInjectionPlan(shards, { budgetBytes: 16384 })
    expect(plan.mode).toBe('index')
    if (plan.mode === 'index') {
      expect(plan.budget).toBe(16384)
      expect(plan.totalBytes).toBe(40000)
    }
  })

  test('respects a custom budget below the default', () => {
    const shards = [shard('a', 800), shard('b', 800)]
    const plan = buildInjectionPlan(shards, { budgetBytes: 1024 })
    expect(plan.mode).toBe('index')
  })

  test('handles a single shard larger than the budget', () => {
    const shards = [shard('huge', 20_000)]
    const plan = buildInjectionPlan(shards, { budgetBytes: 16384 })
    expect(plan.mode).toBe('index')
    expect(plan.shards).toHaveLength(1)
  })

  test('returns direct mode for an empty shards array', () => {
    const plan = buildInjectionPlan([], { budgetBytes: 16384 })
    expect(plan.mode).toBe('direct')
    expect(plan.shards).toEqual([])
  })

  test('threshold boundary: total bytes === budget stays in direct mode (≤ semantics)', () => {
    const shards = [shard('a', 1024)]
    const plan = buildInjectionPlan(shards, { budgetBytes: 1024 })
    expect(plan.mode).toBe('direct')
  })

  test('uses the default budget when no option is supplied', () => {
    const shards = [shard('a', DEFAULT_INJECTION_BUDGET_BYTES + 1)]
    const plan = buildInjectionPlan(shards)
    expect(plan.mode).toBe('index')
    if (plan.mode === 'index') expect(plan.budget).toBe(DEFAULT_INJECTION_BUDGET_BYTES)
  })

  test('counts utf-8 byte length, not character length, for multibyte bodies', () => {
    const multibyte = shard('multi', 0)
    multibyte.body = '한글'.repeat(2000)
    const plan = buildInjectionPlan([multibyte], { budgetBytes: 1024 })
    expect(plan.mode).toBe('index')
  })
})
