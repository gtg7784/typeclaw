import { describe, expect, test } from 'bun:test'

import { fragmentContentHash, parseFragments } from './fragment-parser'

describe('parseFragments', () => {
  test('returns empty for content with no fragment markers', () => {
    expect(
      parseFragments(
        '{"type":"watermark","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"11111111"}\n',
      ),
    ).toEqual([])
  })

  test('extracts a single fragment with topic and body', () => {
    const content =
      '{"type":"fragment","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"11111111","topic":"Bug Fix","body":"one line body"}\n'
    const fragments = parseFragments(content)
    expect(fragments).toHaveLength(1)
    expect(fragments[0]).toEqual({ source: 'ses_a', entry: '11111111', topic: 'Bug Fix', body: 'one line body' })
  })

  test('extracts multiple fragments in document order', () => {
    const content = [
      '{"type":"fragment","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"aaaa","topic":"first","body":"body one"}',
      '{"type":"fragment","id":"evt-2","ts":"2026-05-16T12:00:00.000Z","source":"ses_b","entry":"bbbb","topic":"second","body":"body two"}',
    ].join('\n')
    const fragments = parseFragments(content)
    expect(fragments.map((f) => f.topic)).toEqual(['first', 'second'])
    expect(fragments.map((f) => f.entry)).toEqual(['aaaa', 'bbbb'])
  })

  test('stops a fragment body at the next fragment marker (does not bleed)', () => {
    const content = [
      '{"type":"fragment","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"11","topic":"first","body":"first body"}',
      '{"type":"fragment","id":"evt-2","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"22","topic":"second","body":"second body"}',
    ].join('\n')
    const fragments = parseFragments(content)
    expect(fragments[0]!.body).toBe('first body')
    expect(fragments[1]!.body).toBe('second body')
  })

  test('stops a fragment body at the next bare watermark marker', () => {
    const content = [
      '{"type":"fragment","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"11","topic":"first","body":"first body"}',
      '{"type":"watermark","id":"evt-2","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"22"}',
    ].join('\n')
    const fragments = parseFragments(content)
    expect(fragments).toHaveLength(1)
    expect(fragments[0]!.body).toBe('first body')
  })

  test('ignores bare watermark markers (they have no topic or body to parse)', () => {
    const content =
      '{"type":"watermark","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"quietday"}\n'
    expect(parseFragments(content)).toEqual([])
  })

  test('skips a fragment header that has no topic line following it', () => {
    // In JSONL, a line missing required fragment fields is skipped
    const content = '{"type":"fragment","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"11"}\n'
    expect(parseFragments(content)).toEqual([])
  })

  test('preserves multi-line bodies verbatim', () => {
    const content =
      '{"type":"fragment","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"11","topic":"Topic","body":"**Claim**: one\\n**Evidence**: two\\n\\n**Implication**: three"}\n'
    const fragment = parseFragments(content)[0]!
    expect(fragment.body).toBe(['**Claim**: one', '**Evidence**: two', '', '**Implication**: three'].join('\n'))
  })

  test('tolerates extra attributes on the fragment marker (forward compat)', () => {
    const content =
      '{"type":"fragment","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"11","topic":"Topic","body":"body","extra":"value"}\n'
    expect(parseFragments(content)[0]).toMatchObject({ source: 'ses_a', entry: '11', topic: 'Topic', body: 'body' })
  })

  test('parseFragments with watermark events interleaved → only fragments returned', () => {
    const content = [
      '{"type":"watermark","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"w1"}',
      '{"type":"fragment","id":"evt-2","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"f1","topic":"Topic 1","body":"body 1"}',
      '{"type":"watermark","id":"evt-3","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"w2"}',
      '{"type":"fragment","id":"evt-4","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"f2","topic":"Topic 2","body":"body 2"}',
    ].join('\n')
    const fragments = parseFragments(content)
    expect(fragments).toHaveLength(2)
    expect(fragments.map((f) => f.topic)).toEqual(['Topic 1', 'Topic 2'])
  })

  test('parseFragments with legacy_prose events → only fragments returned', () => {
    const content = [
      '{"type":"legacy_prose","ts":"2026-05-16T12:00:00.000Z","text":"old prose","origin":"migration"}',
      '{"type":"fragment","id":"evt-1","ts":"2026-05-16T12:00:00.000Z","source":"ses_a","entry":"f1","topic":"Topic","body":"body"}',
      '{"type":"legacy_prose","ts":"2026-05-16T12:00:00.000Z","text":"more old prose","origin":"migration"}',
    ].join('\n')
    const fragments = parseFragments(content)
    expect(fragments).toHaveLength(1)
    expect(fragments[0]).toEqual({ source: 'ses_a', entry: 'f1', topic: 'Topic', body: 'body' })
  })
})

describe('fragmentContentHash', () => {
  test('produces a stable hex sha256 string', () => {
    const hash = fragmentContentHash({ topic: 'Topic', body: 'body' })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('two fragments with identical topic+body hash to the same value', () => {
    const a = { topic: 'My Topic', body: 'shared body' }
    const b = { topic: 'My Topic', body: 'shared body' }
    expect(fragmentContentHash(a)).toBe(fragmentContentHash(b))
  })

  test('different topics with the same body produce different hashes', () => {
    expect(fragmentContentHash({ topic: 'a', body: 'shared' })).not.toBe(
      fragmentContentHash({ topic: 'b', body: 'shared' }),
    )
  })

  test('different bodies with the same topic produce different hashes', () => {
    expect(fragmentContentHash({ topic: 'shared', body: 'a' })).not.toBe(
      fragmentContentHash({ topic: 'shared', body: 'b' }),
    )
  })

  test('ignores trailing whitespace on body lines (semantic equivalence)', () => {
    expect(fragmentContentHash({ topic: 'T', body: 'line  ' })).toBe(fragmentContentHash({ topic: 'T', body: 'line' }))
  })

  test('ignores leading and trailing blank lines on body (semantic equivalence)', () => {
    expect(fragmentContentHash({ topic: 'T', body: '\n\nbody\n\n' })).toBe(
      fragmentContentHash({ topic: 'T', body: 'body' }),
    )
  })

  test('does NOT collapse near-duplicates that differ in actual content', () => {
    expect(fragmentContentHash({ topic: 'Decision', body: 'use option A because faster' })).not.toBe(
      fragmentContentHash({ topic: 'Decision', body: 'use option B because faster' }),
    )
  })
})
