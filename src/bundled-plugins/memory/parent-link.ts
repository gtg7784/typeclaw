import { splitCitationsBySection } from './citations'
import type { TopicShard } from './load-shards'

export type ParentLinks = {
  supersededFragmentIds: Set<string>
  parentSlugByFragmentId: Map<string, string>
}

export function buildParentLinks(shards: TopicShard[]): ParentLinks {
  const parentSlugByFragmentId = new Map<string, string>()
  const supersededFragmentIds = new Set<string>()

  for (const shard of shards) {
    const { active, superseded } = splitCitationsBySection(shard.body)
    for (const fragmentId of active) {
      if (!parentSlugByFragmentId.has(fragmentId)) parentSlugByFragmentId.set(fragmentId, shard.slug)
    }
    for (const fragmentId of superseded) supersededFragmentIds.add(fragmentId)
  }

  // Active in one shard outranks superseded in another: the fragment still backs
  // a live belief, so it stays a valid retrieval hook.
  for (const fragmentId of parentSlugByFragmentId.keys()) supersededFragmentIds.delete(fragmentId)

  return { parentSlugByFragmentId, supersededFragmentIds }
}
