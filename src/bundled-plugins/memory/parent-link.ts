import { splitCitationsBySection } from './citations'
import type { TopicShard } from './load-shards'

export type ParentLinks = {
  supersededFragmentIds: Set<string>
  parentSlugsByFragmentId: Map<string, Set<string>>
}

export function buildParentLinks(shards: TopicShard[]): ParentLinks {
  const parentSlugsByFragmentId = new Map<string, Set<string>>()
  const supersededFragmentIds = new Set<string>()

  for (const shard of shards) {
    const { active, superseded } = splitCitationsBySection(shard.body)
    // A fragment can be cited by multiple topics (it backs more than one belief),
    // so collect every citing slug — first-wins would drop the fragment's other
    // parents and a match would collapse to only one of them.
    for (const fragmentId of active) addSlug(parentSlugsByFragmentId, fragmentId, shard.slug)
    for (const fragmentId of superseded) supersededFragmentIds.add(fragmentId)
  }

  // Active in one shard outranks superseded in another: the fragment still backs
  // a live belief, so it stays a valid retrieval hook.
  for (const fragmentId of parentSlugsByFragmentId.keys()) supersededFragmentIds.delete(fragmentId)

  return { parentSlugsByFragmentId, supersededFragmentIds }
}

function addSlug(map: Map<string, Set<string>>, fragmentId: string, slug: string): void {
  const slugs = map.get(fragmentId)
  if (slugs === undefined) map.set(fragmentId, new Set([slug]))
  else slugs.add(slug)
}
