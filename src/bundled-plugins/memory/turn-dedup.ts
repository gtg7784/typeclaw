import type { TopicShard } from './load-shards'

export type InjectedShardState = Map<string, string>

export type DirectShardPartition = {
  full: TopicShard[]
  unchanged: TopicShard[]
}

// Preserves the "nothing the agent always had vanishes on an off-topic turn"
// guarantee by AVAILABILITY, not literal presence: an unchanged shard is still
// named (heading + slug) and its body is recoverable via memory_search, while a
// changed shard always re-injects in full so the agent never reads a stale body.
// `state` is the session-scoped record the caller owns and clears on session.end.
export function partitionDirectShards(shards: TopicShard[], state: InjectedShardState): DirectShardPartition {
  const full: TopicShard[] = []
  const unchanged: TopicShard[] = []
  for (const shard of shards) {
    const hash = hashBody(shard.body)
    if (state.get(shard.slug) === hash) {
      unchanged.push(shard)
    } else {
      full.push(shard)
      state.set(shard.slug, hash)
    }
  }
  return { full, unchanged }
}

// FNV-1a over the body. A hash collision only suppresses a body the agent can
// still re-fetch by slug, so collision-tolerance buys a cheap one-string-per-slug
// state map instead of retaining full bodies per session.
function hashBody(body: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
