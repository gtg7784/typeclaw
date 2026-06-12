import { describe, expect, test } from 'bun:test'

import type { TopicShard } from './load-shards'
import { type InjectedShardState, partitionDirectShards } from './turn-dedup'

function shard(slug: string, body: string): TopicShard {
  return {
    path: `/tmp/agent/memory/topics/${slug}.md`,
    slug,
    frontmatter: { heading: slug, cites: 1, days: 1, lastReinforced: '2026-06-11' },
    body,
  }
}

describe('partitionDirectShards', () => {
  test('first turn renders every shard in full and records them', () => {
    const state: InjectedShardState = new Map()
    const shards = [shard('a', 'body a'), shard('b', 'body b')]

    const { full, unchanged } = partitionDirectShards(shards, state)

    expect(full.map((s) => s.slug)).toEqual(['a', 'b'])
    expect(unchanged).toHaveLength(0)
    expect(state.size).toBe(2)
  })

  test('second turn with unchanged bodies dedups all shards to references', () => {
    const state: InjectedShardState = new Map()
    const shards = [shard('a', 'body a'), shard('b', 'body b')]
    partitionDirectShards(shards, state)

    const { full, unchanged } = partitionDirectShards(shards, state)

    expect(full).toHaveLength(0)
    expect(unchanged.map((s) => s.slug)).toEqual(['a', 'b'])
  })

  test('a shard whose body changed re-injects in full while siblings stay deduped', () => {
    const state: InjectedShardState = new Map()
    partitionDirectShards([shard('a', 'body a'), shard('b', 'body b')], state)

    const { full, unchanged } = partitionDirectShards([shard('a', 'body a v2'), shard('b', 'body b')], state)

    expect(full.map((s) => s.slug)).toEqual(['a'])
    expect(unchanged.map((s) => s.slug)).toEqual(['b'])
  })

  test('a never-seen shard appearing on a later turn injects in full', () => {
    const state: InjectedShardState = new Map()
    partitionDirectShards([shard('a', 'body a')], state)

    const { full, unchanged } = partitionDirectShards([shard('a', 'body a'), shard('c', 'body c')], state)

    expect(full.map((s) => s.slug)).toEqual(['c'])
    expect(unchanged.map((s) => s.slug)).toEqual(['a'])
  })

  test('a changed-then-reverted body re-injects in full after the change turn', () => {
    const state: InjectedShardState = new Map()
    partitionDirectShards([shard('a', 'v1')], state)
    partitionDirectShards([shard('a', 'v2')], state)

    const { full, unchanged } = partitionDirectShards([shard('a', 'v2')], state)

    expect(full).toHaveLength(0)
    expect(unchanged.map((s) => s.slug)).toEqual(['a'])
  })

  test('distinct bodies do not collide', () => {
    const state: InjectedShardState = new Map()
    partitionDirectShards([shard('a', 'alpha'), shard('b', 'beta')], state)

    const { unchanged } = partitionDirectShards([shard('a', 'alpha'), shard('b', 'beta')], state)

    expect(unchanged.map((s) => s.slug)).toEqual(['a', 'b'])
  })
})
