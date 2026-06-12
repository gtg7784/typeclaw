import { describe, expect, test } from 'bun:test'

import type { TopicShard } from './load-shards'
import { buildParentLinks } from './parent-link'

const ID_BUN = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
const ID_PNPM = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
const ID_OTHER = '019e2ee8-bcc4-772f-8821-876162c5e601'

function shard(slug: string, body: string): TopicShard {
  return {
    path: `/agent/memory/topics/${slug}.md`,
    slug,
    frontmatter: { heading: slug, cites: 0, days: 0, lastReinforced: '2026-05-20' },
    body,
  }
}

describe('buildParentLinks', () => {
  test('maps active fragments to their parent slug and collects superseded ids', () => {
    // given a topic whose belief switched bun -> pnpm, keeping bun as superseded evidence
    const shards = [
      shard(
        'package-manager',
        [
          'User uses pnpm.',
          'fragments:',
          `- streams/2026-05-21#${ID_PNPM}`,
          'superseded:',
          `- streams/2026-05-20#${ID_BUN}`,
        ].join('\n'),
      ),
    ]

    // when
    const { parentSlugsByFragmentId, supersededFragmentIds } = buildParentLinks(shards)

    // then
    expect(parentSlugsByFragmentId.get(ID_PNPM)).toEqual(new Set(['package-manager']))
    expect(parentSlugsByFragmentId.has(ID_BUN)).toBe(false)
    expect(supersededFragmentIds).toEqual(new Set([ID_BUN]))
  })

  test('collects ALL citing topics when a fragment is cited by more than one', () => {
    // given one fragment cited by two distinct topics (it backs both beliefs)
    const shards = [
      shard('package-manager', ['Uses pnpm.', 'fragments:', `- streams/2026-05-20#${ID_OTHER}`].join('\n')),
      shard('docker-preferences', ['Minimal images.', 'fragments:', `- streams/2026-05-20#${ID_OTHER}`].join('\n')),
    ]

    // when
    const { parentSlugsByFragmentId } = buildParentLinks(shards)

    // then both parents are kept, not just the first
    expect(parentSlugsByFragmentId.get(ID_OTHER)).toEqual(new Set(['package-manager', 'docker-preferences']))
  })

  test('active in one shard outranks superseded in another', () => {
    const shards = [
      shard('current', ['Current.', 'fragments:', `- streams/2026-05-21#${ID_PNPM}`].join('\n')),
      shard('history', ['History.', 'superseded:', `- streams/2026-05-21#${ID_PNPM}`].join('\n')),
    ]

    const { parentSlugsByFragmentId, supersededFragmentIds } = buildParentLinks(shards)

    expect(parentSlugsByFragmentId.get(ID_PNPM)).toEqual(new Set(['current']))
    expect(supersededFragmentIds.has(ID_PNPM)).toBe(false)
  })

  test('empty shards yield empty links', () => {
    const { parentSlugsByFragmentId, supersededFragmentIds } = buildParentLinks([])

    expect(parentSlugsByFragmentId.size).toBe(0)
    expect(supersededFragmentIds.size).toBe(0)
  })
})
