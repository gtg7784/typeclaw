import { describe, expect, test } from 'bun:test'

import {
  checkCitationSuperset,
  checkCitationSupersetAcrossShards,
  summarizeMissingCitations,
} from './citation-superset'

const ID_A = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
const ID_B = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
const ID_C = '019e2ee8-bcc4-772f-8821-876162c5e601'
const ID_D = '019e2ef0-aaaa-77ef-bbbb-cccccccccccc'

describe('checkCitationSuperset', () => {
  test('returns ok when old is empty (first-ever dreaming run)', () => {
    expect(checkCitationSuperset('', `- memory/2026-05-16#${ID_A}`)).toEqual({ ok: true })
    expect(checkCitationSuperset('# Memory\n', `- memory/2026-05-16#${ID_A}`)).toEqual({ ok: true })
  })

  test('returns ok when new is a strict superset of old', () => {
    const oldText = `- memory/2026-05-16#${ID_A}`
    const newText = [`- memory/2026-05-16#${ID_A}`, `- memory/2026-05-16#${ID_B}`].join('\n')

    expect(checkCitationSuperset(oldText, newText)).toEqual({ ok: true })
  })

  test('returns ok when new exactly equals old', () => {
    const text = [`- memory/2026-05-16#${ID_A}`, `- memory/2026-05-15#${ID_B}`].join('\n')

    expect(checkCitationSuperset(text, text)).toEqual({ ok: true })
  })

  test('returns ok across topic restructure when every old id is still cited somewhere new', () => {
    const oldText = ['## Topic A', `- memory/2026-05-16#${ID_A}`, '## Topic B', `- memory/2026-05-15#${ID_B}`].join(
      '\n',
    )
    const newText = ['## Merged', `- memory/2026-05-16#${ID_A}`, `- memory/2026-05-15#${ID_B}`].join('\n')

    expect(checkCitationSuperset(oldText, newText)).toEqual({ ok: true })
  })

  test('returns failure listing the dropped ids when new is missing an old citation', () => {
    const oldText = [`- memory/2026-05-16#${ID_A}`, `- memory/2026-05-15#${ID_B}`, `- memory/2026-05-15#${ID_C}`].join(
      '\n',
    )
    const newText = [`- memory/2026-05-16#${ID_A}`].join('\n')

    const verdict = checkCitationSuperset(oldText, newText)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.missing).toEqual([
        { date: '2026-05-15', fragmentId: ID_B },
        { date: '2026-05-15', fragmentId: ID_C },
      ])
    }
  })

  test('reports missing ids sorted by date then id (stable for log/test assertions)', () => {
    const oldText = [
      `- memory/2026-05-16#${ID_C}`,
      `- memory/2026-05-16#${ID_A}`,
      `- memory/2026-05-15#${ID_D}`,
      `- memory/2026-05-15#${ID_B}`,
    ].join('\n')
    const newText = ''

    const verdict = checkCitationSuperset(oldText, newText)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.missing).toEqual([
        { date: '2026-05-15', fragmentId: ID_B },
        { date: '2026-05-15', fragmentId: ID_D },
        { date: '2026-05-16', fragmentId: ID_A },
        { date: '2026-05-16', fragmentId: ID_C },
      ])
    }
  })

  test('returns failure when new drops an entire date (whole topic deleted)', () => {
    const oldText = [`- memory/2026-05-16#${ID_A}`, `- memory/2026-05-15#${ID_B}`].join('\n')
    const newText = `- memory/2026-05-16#${ID_A}`

    const verdict = checkCitationSuperset(oldText, newText)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.missing).toEqual([{ date: '2026-05-15', fragmentId: ID_B }])
    }
  })

  test('treats inline-prose citations the same as fragments: bullets', () => {
    const oldText = `prose mentions memory/2026-05-16#${ID_A} once`
    const newText = ''

    const verdict = checkCitationSuperset(oldText, newText)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.missing).toEqual([{ date: '2026-05-16', fragmentId: ID_A }])
  })

  test('reference citations (references/<slug>) are excluded from the superset check', () => {
    const oldText = [`- streams/2026-05-16#${ID_A}`, 'references:', '- references/ref-a'].join('\n')
    const newText = `- streams/2026-05-16#${ID_A}`

    expect(checkCitationSuperset(oldText, newText)).toEqual({ ok: true })

    const verdict = checkCitationSuperset(oldText, 'references:\n- references/ref-a')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.missing).toEqual([{ date: '2026-05-16', fragmentId: ID_A }])
  })
})

describe('checkCitationSupersetAcrossShards', () => {
  test('returns ok when duplicate old citations merge into one new shard', () => {
    const oldShards = new Map([
      ['memory/topics/a.md', `- memory/2026-05-20#${ID_A}`],
      ['memory/topics/b.md', `prose memory/2026-05-20#${ID_A}`],
    ])
    const newShards = new Map([['memory/topics/c.md', `- memory/2026-05-20#${ID_A}`]])

    expect(checkCitationSupersetAcrossShards(oldShards, newShards)).toEqual({ ok: true })
  })

  test('returns ok when one old shard splits citations across new shards', () => {
    const oldShards = new Map([
      [
        'memory/topics/a.md',
        [`- memory/2026-05-20#${ID_A}`, `- memory/2026-05-20#${ID_B}`, `- memory/2026-05-21#${ID_C}`].join('\n'),
      ],
    ])
    const newShards = new Map([
      ['memory/topics/a.md', `- memory/2026-05-20#${ID_A}`],
      ['memory/topics/b.md', [`- memory/2026-05-20#${ID_B}`, `- memory/2026-05-21#${ID_C}`].join('\n')],
    ])

    expect(checkCitationSupersetAcrossShards(oldShards, newShards)).toEqual({ ok: true })
  })

  test('returns ok when new shards introduce additional citations', () => {
    const oldShards = new Map([['memory/topics/a.md', `- memory/2026-05-20#${ID_A}`]])
    const newShards = new Map([
      ['memory/topics/a.md', `- memory/2026-05-20#${ID_A}`],
      ['memory/topics/b.md', `- memory/2026-05-21#${ID_B}`],
    ])

    expect(checkCitationSupersetAcrossShards(oldShards, newShards)).toEqual({ ok: true })
  })

  test('returns failure when a citation is dropped from all new shards', () => {
    const oldShards = new Map([
      ['memory/topics/a.md', `- memory/2026-05-20#${ID_A}`],
      ['memory/topics/b.md', `- memory/2026-05-21#${ID_B}`],
    ])
    const newShards = new Map([['memory/topics/a.md', `- memory/2026-05-21#${ID_B}`]])

    const verdict = checkCitationSupersetAcrossShards(oldShards, newShards)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.missing).toEqual([{ date: '2026-05-20', fragmentId: ID_A }])
  })

  test('returns ok when a stale shard is deleted after its citations move elsewhere', () => {
    const oldShards = new Map([
      ['memory/topics/a.md', `- memory/2026-05-20#${ID_A}`],
      ['memory/topics/b.md', `- memory/2026-05-21#${ID_B}`],
    ])
    const newShards = new Map([
      ['memory/topics/b.md', [`- memory/2026-05-20#${ID_A}`, `- memory/2026-05-21#${ID_B}`].join('\n')],
    ])

    expect(checkCitationSupersetAcrossShards(oldShards, newShards)).toEqual({ ok: true })
  })

  test('returns ok when both shard maps are empty', () => {
    expect(checkCitationSupersetAcrossShards(new Map(), new Map())).toEqual({ ok: true })
  })

  test('returns ok when old shards are empty and new shards contain citations', () => {
    const newShards = new Map([['memory/topics/a.md', `- memory/2026-05-20#${ID_A}`]])

    expect(checkCitationSupersetAcrossShards(new Map(), newShards)).toEqual({ ok: true })
  })

  test('matches citations by date and id across accepted citation prefixes', () => {
    const oldShards = new Map([['memory/topics/a.md', `- memory/2026-05-20#${ID_A}`]])
    const newShards = new Map([['memory/topics/b.md', `- streams/2026-05-20#${ID_A}`]])

    expect(checkCitationSupersetAcrossShards(oldShards, newShards)).toEqual({ ok: true })
  })
})

describe('summarizeMissingCitations', () => {
  test('returns the full list when 3 or fewer are missing', () => {
    expect(
      summarizeMissingCitations([
        { date: '2026-05-15', fragmentId: ID_A },
        { date: '2026-05-15', fragmentId: ID_B },
      ]),
    ).toBe(`2026-05-15#${ID_A}, 2026-05-15#${ID_B}`)
  })

  test('truncates to the first 3 with a +N more suffix for longer lists', () => {
    expect(
      summarizeMissingCitations([
        { date: '2026-05-15', fragmentId: ID_A },
        { date: '2026-05-15', fragmentId: ID_B },
        { date: '2026-05-15', fragmentId: ID_C },
        { date: '2026-05-15', fragmentId: ID_D },
        { date: '2026-05-16', fragmentId: ID_A },
      ]),
    ).toBe(`2026-05-15#${ID_A}, 2026-05-15#${ID_B}, 2026-05-15#${ID_C} (+2 more)`)
  })

  test('handles an empty list cleanly (caller guarantee, but defensive)', () => {
    expect(summarizeMissingCitations([])).toBe('')
  })
})
