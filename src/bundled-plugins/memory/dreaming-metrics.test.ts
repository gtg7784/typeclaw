import { describe, expect, test } from 'bun:test'

import { computeDreamingMetrics } from './dreaming-metrics'

const ID_A = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
const ID_B = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'

function snap(entries: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(entries).map(([path, body]) => [path, Buffer.from(body, 'utf8')]))
}

describe('computeDreamingMetrics', () => {
  test('counts created and removed topics by path diff', () => {
    // given: one topic survives, one is new, one was removed (merged away)
    const before = snap({ '/t/keep.md': 'a', '/t/gone.md': 'b' })
    const after = snap({ '/t/keep.md': 'a', '/t/new.md': 'c' })

    expect(computeDreamingMetrics(before, after)).toEqual({
      topicsCreated: 1,
      topicsRemoved: 1,
      supersededDelta: 0,
      referencesDemoted: 0,
      referencesEvicted: 0,
    })
  })

  test('reports net superseded citations gained this run', () => {
    // given: a belief switched, moving one fragment into superseded:
    const before = snap({ '/t/pm.md': ['Uses bun.', 'fragments:', `- streams/2026-06-10#${ID_A}`].join('\n') })
    const after = snap({
      '/t/pm.md': [
        'Uses pnpm.',
        'fragments:',
        `- streams/2026-06-11#${ID_B}`,
        'superseded:',
        `- streams/2026-06-10#${ID_A}`,
      ].join('\n'),
    })

    expect(computeDreamingMetrics(before, after).supersededDelta).toBe(1)
  })

  test('empty before and after yield all zeros', () => {
    expect(computeDreamingMetrics(new Map(), new Map())).toEqual({
      topicsCreated: 0,
      topicsRemoved: 0,
      supersededDelta: 0,
      referencesDemoted: 0,
      referencesEvicted: 0,
    })
  })
})
