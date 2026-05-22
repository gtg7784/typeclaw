import { describe, expect, test } from 'bun:test'

import { parseShard, renderShard, updateFrontmatter, type ShardFrontmatter } from './frontmatter'

describe('parseShard', () => {
  test('round-trip canonical input', () => {
    const input = `---\nheading: Design system tokens\ncites: 5\ndays: 3\nlastReinforced: 2026-05-20\ntags: [design, css]\n---\nBody text here.\n`
    const parsed = parseShard(input)
    expect(parsed.frontmatter).toEqual({
      heading: 'Design system tokens',
      cites: 5,
      days: 3,
      lastReinforced: '2026-05-20',
      tags: ['design', 'css'],
    })
    expect(parsed.body).toBe('Body text here.\n')
    expect(renderShard(parsed.frontmatter, parsed.body)).toBe(input)
  })

  test('missing top delimiter throws', () => {
    expect(() => parseShard('heading: foo\n---\nbody')).toThrow('frontmatter delimiter missing')
  })

  test('missing bottom delimiter throws', () => {
    expect(() => parseShard('---\nheading: foo\n')).toThrow('frontmatter delimiter missing')
  })

  test('cites not-a-number throws precise error', () => {
    expect(() =>
      parseShard('---\nheading: foo\ncites: not-a-number\ndays: 1\nlastReinforced: 2026-05-20\n---\n'),
    ).toThrow("frontmatter field 'cites': expected non-negative integer, got 'not-a-number'")
  })

  test('missing required field heading throws', () => {
    expect(() => parseShard('---\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\n---\n')).toThrow(
      "frontmatter field 'heading': required",
    )
  })

  test('empty body is allowed', () => {
    const input = '---\nheading: Foo\ncites: 0\ndays: 0\nlastReinforced: 2026-05-20\n---\n'
    const parsed = parseShard(input)
    expect(parsed.body).toBe('')
    expect(parsed.frontmatter.heading).toBe('Foo')
  })

  test('tags as inline array parses', () => {
    const input = '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\ntags: [foo, bar]\n---\nbody\n'
    const parsed = parseShard(input)
    expect(parsed.frontmatter.tags).toEqual(['foo', 'bar'])
  })

  test('tags absent vs empty array distinction', () => {
    const absent = '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\n---\nbody\n'
    const withEmpty = '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\ntags: []\n---\nbody\n'

    const parsedAbsent = parseShard(absent)
    expect(parsedAbsent.frontmatter.tags).toBeUndefined()
    expect(renderShard(parsedAbsent.frontmatter, parsedAbsent.body)).toBe(absent)

    const parsedEmpty = parseShard(withEmpty)
    expect(parsedEmpty.frontmatter.tags).toEqual([])
    expect(renderShard(parsedEmpty.frontmatter, parsedEmpty.body)).toBe(withEmpty)
  })

  test('malformed lastReinforced throws', () => {
    expect(() => parseShard('---\nheading: foo\ncites: 1\ndays: 1\nlastReinforced: 2026/05/20\n---\n')).toThrow(
      "frontmatter field 'lastReinforced': expected YYYY-MM-DD, got '2026/05/20'",
    )
    expect(() => parseShard('---\nheading: foo\ncites: 1\ndays: 1\nlastReinforced: not-a-date\n---\n')).toThrow(
      "frontmatter field 'lastReinforced': expected YYYY-MM-DD, got 'not-a-date'",
    )
  })

  test('unknown frontmatter field throws', () => {
    expect(() =>
      parseShard('---\nheading: foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\nextra: value\n---\n'),
    ).toThrow("frontmatter field 'extra': unknown")
  })

  test('tags as YAML list parses', () => {
    const input = `---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\ntags:\n  - foo\n  - bar\n---\nbody\n`
    const parsed = parseShard(input)
    expect(parsed.frontmatter.tags).toEqual(['foo', 'bar'])
  })

  test('negative cites throws', () => {
    expect(() => parseShard('---\nheading: foo\ncites: -1\ndays: 1\nlastReinforced: 2026-05-20\n---\n')).toThrow(
      "frontmatter field 'cites': expected non-negative integer, got '-1'",
    )
  })

  test('negative days throws', () => {
    expect(() => parseShard('---\nheading: foo\ncites: 1\ndays: -1\nlastReinforced: 2026-05-20\n---\n')).toThrow(
      "frontmatter field 'days': expected non-negative integer, got '-1'",
    )
  })
})

describe('renderShard', () => {
  test('omits tags when undefined', () => {
    const fm: ShardFrontmatter = {
      heading: 'Foo',
      cites: 1,
      days: 1,
      lastReinforced: '2026-05-20',
    }
    expect(renderShard(fm, 'body')).toBe('---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\n---\nbody')
  })

  test('renders tags as inline array', () => {
    const fm: ShardFrontmatter = {
      heading: 'Foo',
      cites: 1,
      days: 1,
      lastReinforced: '2026-05-20',
      tags: ['a', 'b'],
    }
    expect(renderShard(fm, 'body')).toBe(
      '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\ntags: [a, b]\n---\nbody',
    )
  })

  test('renders empty tags array', () => {
    const fm: ShardFrontmatter = {
      heading: 'Foo',
      cites: 1,
      days: 1,
      lastReinforced: '2026-05-20',
      tags: [],
    }
    expect(renderShard(fm, 'body')).toBe(
      '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\ntags: []\n---\nbody',
    )
  })

  test('preserves leading and trailing newlines in body', () => {
    const fm: ShardFrontmatter = {
      heading: 'Foo',
      cites: 0,
      days: 0,
      lastReinforced: '2026-05-20',
    }
    expect(renderShard(fm, '\n\nbody\n\n')).toBe(
      '---\nheading: Foo\ncites: 0\ndays: 0\nlastReinforced: 2026-05-20\n---\n\n\nbody\n\n',
    )
  })
})

describe('updateFrontmatter', () => {
  test('applies patch and preserves body verbatim', () => {
    const input = '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\n---\nBody text\n'
    const output = updateFrontmatter(input, { cites: 5, lastReinforced: '2026-05-21' })
    expect(output).toBe('---\nheading: Foo\ncites: 5\ndays: 1\nlastReinforced: 2026-05-21\n---\nBody text\n')
  })

  test('adds tags when previously absent', () => {
    const input = '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\n---\nBody\n'
    const output = updateFrontmatter(input, { tags: ['new', 'tags'] })
    expect(output).toBe(
      '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\ntags: [new, tags]\n---\nBody\n',
    )
  })

  test('removes tags when patched to undefined', () => {
    const input = '---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\ntags: [old]\n---\nBody\n'
    const output = updateFrontmatter(input, { tags: undefined })
    expect(output).toBe('---\nheading: Foo\ncites: 1\ndays: 1\nlastReinforced: 2026-05-20\n---\nBody\n')
  })
})
