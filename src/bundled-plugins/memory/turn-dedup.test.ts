import { describe, expect, test } from 'bun:test'

import type { RetrievedMemoryItem } from './load-memory'
import { type InjectedMemoryState, partitionRetrievedMemoryItems } from './turn-dedup'

function item(key: string, excerpt: string): RetrievedMemoryItem {
  return {
    source: 'topic',
    key,
    heading: key,
    excerpt,
  }
}

describe('partitionRetrievedMemoryItems', () => {
  test('first turn renders every retrieved item and records it', () => {
    const state: InjectedMemoryState = new Map()
    const items = [item('a', 'excerpt a'), item('b', 'excerpt b')]

    const { fresh, unchanged } = partitionRetrievedMemoryItems(items, state)

    expect(fresh.map((s) => s.key)).toEqual(['a', 'b'])
    expect(unchanged).toHaveLength(0)
    expect(state.size).toBe(2)
  })

  test('second turn with unchanged excerpts dedups all items to references', () => {
    const state: InjectedMemoryState = new Map()
    const items = [item('a', 'excerpt a'), item('b', 'excerpt b')]
    partitionRetrievedMemoryItems(items, state)

    const { fresh, unchanged } = partitionRetrievedMemoryItems(items, state)

    expect(fresh).toHaveLength(0)
    expect(unchanged.map((s) => s.key)).toEqual(['a', 'b'])
  })

  test('an item whose excerpt changed re-injects while siblings stay deduped', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'excerpt a'), item('b', 'excerpt b')], state)

    const { fresh, unchanged } = partitionRetrievedMemoryItems(
      [item('a', 'excerpt a v2'), item('b', 'excerpt b')],
      state,
    )

    expect(fresh.map((s) => s.key)).toEqual(['a'])
    expect(unchanged.map((s) => s.key)).toEqual(['b'])
  })

  test('a never-seen item appearing on a later turn injects', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'excerpt a')], state)

    const { fresh, unchanged } = partitionRetrievedMemoryItems([item('a', 'excerpt a'), item('c', 'excerpt c')], state)

    expect(fresh.map((s) => s.key)).toEqual(['c'])
    expect(unchanged.map((s) => s.key)).toEqual(['a'])
  })

  test('a changed-then-stable excerpt dedups after the change turn', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'v1')], state)
    partitionRetrievedMemoryItems([item('a', 'v2')], state)

    const { fresh, unchanged } = partitionRetrievedMemoryItems([item('a', 'v2')], state)

    expect(fresh).toHaveLength(0)
    expect(unchanged.map((s) => s.key)).toEqual(['a'])
  })

  test('distinct excerpts do not collide', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'alpha'), item('b', 'beta')], state)

    const { unchanged } = partitionRetrievedMemoryItems([item('a', 'alpha'), item('b', 'beta')], state)

    expect(unchanged.map((s) => s.key)).toEqual(['a', 'b'])
  })

  test('same key with a changed heading re-injects', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'alpha')], state)

    const { fresh } = partitionRetrievedMemoryItems([{ ...item('a', 'alpha'), heading: 'renamed' }], state)

    expect(fresh.map((s) => s.key)).toEqual(['a'])
  })
})
