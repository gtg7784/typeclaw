import type { RetrievedMemoryItem } from './load-memory'

export type InjectedMemoryState = Map<string, string>

export type DedupedRetrievedItem = {
  item: RetrievedMemoryItem
  changed: boolean
}

// Returns items in their input (relevance) order with a per-item `changed`
// flag, never split into separate groups: a high-ranked but previously-seen
// topic must stay ahead of a lower-ranked fresh one, since hybridSearch's
// ranking drives per-turn relevance. `changed` is false when an identical
// excerpt was already injected this session, so the renderer emits a
// recoverable reference instead of re-sending the body.
export function partitionRetrievedMemoryItems(
  items: RetrievedMemoryItem[],
  state: InjectedMemoryState,
): DedupedRetrievedItem[] {
  return items.map((item) => {
    const stateKey = `${item.source}:${item.key}`
    const hash = hashItem(item)
    const changed = state.get(stateKey) !== hash
    if (changed) state.set(stateKey, hash)
    return { item, changed }
  })
}

function hashItem(item: RetrievedMemoryItem): string {
  return hashContent(`${item.heading}\0${item.excerpt}`)
}

// FNV-1a over rendered retrieval content. A hash collision only suppresses an
// excerpt the agent can still re-fetch, so collision-tolerance buys a cheap
// one-string-per-result state map instead of retaining excerpts per session.
function hashContent(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
