import type { RetrievedMemoryItem } from './load-memory'

export type InjectedMemoryState = Map<string, string>

export type RetrievedMemoryPartition = {
  fresh: RetrievedMemoryItem[]
  unchanged: RetrievedMemoryItem[]
}

// Preserves the cross-turn dedup intent after vector turns moved to top-K
// retrieval: an unchanged retrieved excerpt is still named and recoverable via
// memory_search, while changed retrieved content re-injects so the model never
// reasons over a stale excerpt.
export function partitionRetrievedMemoryItems(
  items: RetrievedMemoryItem[],
  state: InjectedMemoryState,
): RetrievedMemoryPartition {
  const fresh: RetrievedMemoryItem[] = []
  const unchanged: RetrievedMemoryItem[] = []
  for (const item of items) {
    const stateKey = `${item.source}:${item.key}`
    const hash = hashItem(item)
    if (state.get(stateKey) === hash) {
      unchanged.push(item)
    } else {
      fresh.push(item)
      state.set(stateKey, hash)
    }
  }
  return { fresh, unchanged }
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
