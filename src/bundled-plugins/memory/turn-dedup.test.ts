import { describe, expect, test } from 'bun:test'

import { renderDedupedRetrievedMemorySection, type RetrievedMemoryItem } from './load-memory'
import { type DedupedRetrievedItem, type InjectedMemoryState, partitionRetrievedMemoryItems } from './turn-dedup'

function item(key: string, excerpt: string): RetrievedMemoryItem {
  return { source: 'topic', key, heading: key, excerpt }
}

const changedKeys = (entries: DedupedRetrievedItem[]) => entries.filter((e) => e.changed).map((e) => e.item.key)
const unchangedKeys = (entries: DedupedRetrievedItem[]) => entries.filter((e) => !e.changed).map((e) => e.item.key)

describe('partitionRetrievedMemoryItems', () => {
  test('first turn marks every retrieved item changed and records it', () => {
    const state: InjectedMemoryState = new Map()
    const items = [item('a', 'excerpt a'), item('b', 'excerpt b')]

    const entries = partitionRetrievedMemoryItems(items, state)

    expect(changedKeys(entries)).toEqual(['a', 'b'])
    expect(unchangedKeys(entries)).toHaveLength(0)
    expect(state.size).toBe(2)
  })

  test('second turn with unchanged excerpts dedups all items to references', () => {
    const state: InjectedMemoryState = new Map()
    const items = [item('a', 'excerpt a'), item('b', 'excerpt b')]
    partitionRetrievedMemoryItems(items, state)

    const entries = partitionRetrievedMemoryItems(items, state)

    expect(changedKeys(entries)).toHaveLength(0)
    expect(unchangedKeys(entries)).toEqual(['a', 'b'])
  })

  test('an item whose excerpt changed re-injects while siblings stay deduped', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'excerpt a'), item('b', 'excerpt b')], state)

    const entries = partitionRetrievedMemoryItems([item('a', 'excerpt a v2'), item('b', 'excerpt b')], state)

    expect(changedKeys(entries)).toEqual(['a'])
    expect(unchangedKeys(entries)).toEqual(['b'])
  })

  test('a never-seen item appearing on a later turn injects', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'excerpt a')], state)

    const entries = partitionRetrievedMemoryItems([item('a', 'excerpt a'), item('c', 'excerpt c')], state)

    expect(changedKeys(entries)).toEqual(['c'])
    expect(unchangedKeys(entries)).toEqual(['a'])
  })

  test('a changed-then-stable excerpt dedups after the change turn', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'v1')], state)
    partitionRetrievedMemoryItems([item('a', 'v2')], state)

    const entries = partitionRetrievedMemoryItems([item('a', 'v2')], state)

    expect(changedKeys(entries)).toHaveLength(0)
    expect(unchangedKeys(entries)).toEqual(['a'])
  })

  test('distinct excerpts do not collide', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'alpha'), item('b', 'beta')], state)

    const entries = partitionRetrievedMemoryItems([item('a', 'alpha'), item('b', 'beta')], state)

    expect(unchangedKeys(entries)).toEqual(['a', 'b'])
  })

  test('same key with a changed heading re-injects', () => {
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('a', 'alpha')], state)

    const entries = partitionRetrievedMemoryItems([{ ...item('a', 'alpha'), heading: 'renamed' }], state)

    expect(changedKeys(entries)).toEqual(['a'])
  })

  test('returns items in input (relevance) order, not grouped by changed status', () => {
    // given: a previously-seen high-ranked item ahead of a fresh lower-ranked one
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('top', 'top body')], state)

    // when: hybridSearch ranks the seen item first, a new item second
    const entries = partitionRetrievedMemoryItems([item('top', 'top body'), item('low', 'low body')], state)

    // then: order is preserved (unchanged top stays first), only status differs
    expect(entries.map((e) => e.item.key)).toEqual(['top', 'low'])
    expect(entries[0]!.changed).toBe(false)
    expect(entries[1]!.changed).toBe(true)
  })
})

describe('renderDedupedRetrievedMemorySection', () => {
  test('renders entries in input order regardless of changed status', () => {
    // given: an unchanged top-ranked hit followed by a fresh lower-ranked hit
    const state: InjectedMemoryState = new Map()
    partitionRetrievedMemoryItems([item('top', 'top body')], state)
    const deduped = partitionRetrievedMemoryItems([item('top', 'top body'), item('low', 'low body')], state)

    // when
    const rendered = renderDedupedRetrievedMemorySection(deduped)

    // then: the high-ranked seen topic is not demoted below the fresh one
    expect(rendered.indexOf('## top')).toBeGreaterThan(-1)
    expect(rendered.indexOf('## top')).toBeLessThan(rendered.indexOf('## low'))
    expect(rendered).toContain('low body')
    expect(rendered).toContain('memory_search({ topic: "top" })')
  })

  test('returns empty string when there are no entries', () => {
    expect(renderDedupedRetrievedMemorySection([])).toBe('')
  })
})
