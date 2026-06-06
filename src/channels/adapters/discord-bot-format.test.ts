import { describe, expect, test } from 'bun:test'

import { convertDiscordTables, displayWidth } from './discord-bot-format'

describe('convertDiscordTables — passthrough', () => {
  test('returns empty string for empty input', () => {
    expect(convertDiscordTables('')).toBe('')
  })

  test('leaves prose without pipes untouched', () => {
    expect(convertDiscordTables('hello world, no table here')).toBe('hello world, no table here')
  })

  test('leaves a lone pipe line untouched (no alignment row)', () => {
    expect(convertDiscordTables('a | b | c\njust prose')).toBe('a | b | c\njust prose')
  })

  test('preserves surrounding prose and blank lines around a table', () => {
    const input = ['intro line', '', '| h1 | h2 |', '|----|----|', '| a | b |', '', 'outro line'].join('\n')
    const result = convertDiscordTables(input)
    expect(result.startsWith('intro line\n\n')).toBe(true)
    expect(result.endsWith('\n\noutro line')).toBe(true)
  })
})

describe('convertDiscordTables — table conversion', () => {
  test('converts a basic table to padded inline-code rows with a bold header', () => {
    const input = [
      '| header1 | header2 | header3 |',
      '|---------|---------|---------|',
      '| r1c1    | r1c2    | r1c3    |',
      '| r2c1    | r2c2    | r2c3    |',
    ].join('\n')

    const expected = [
      '**`header1  header2  header3`**',
      '`r1c1     r1c2     r1c3   `',
      '`r2c1     r2c2     r2c3   `',
    ].join('\n')

    expect(convertDiscordTables(input)).toBe(expected)
  })

  test('pads every column to the widest cell across header and body', () => {
    const input = ['| a | name |', '|---|------|', '| x | bob |', '| yy | alice |'].join('\n')

    const result = convertDiscordTables(input)
    const lines = result.split('\n')

    expect(lines[0]!.startsWith('**`')).toBe(true)
    expect(lines[0]!.endsWith('`**')).toBe(true)
    expect(lines[1]!.startsWith('`')).toBe(true)
    expect(lines[1]!.startsWith('**')).toBe(false)

    const visibleLengths = lines.map((l) => l.replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/^`|`$/g, '').length)
    expect(new Set(visibleLengths).size).toBe(1)
  })

  test('handles a header-only table (no body rows)', () => {
    const input = ['| only | head |', '|------|------|'].join('\n')
    expect(convertDiscordTables(input)).toBe('**`only  head`**')
  })

  test('tolerates missing trailing cells in a body row by padding them', () => {
    const input = ['| a | b | c |', '|---|---|---|', '| 1 | 2 |'].join('\n')
    const lines = convertDiscordTables(input).split('\n')
    const headerLen = lines[0]!.replace(/^\*\*`|`\*\*$/g, '').length
    const rowLen = lines[1]!.replace(/^`|`$/g, '').length
    expect(rowLen).toBe(headerLen)
  })

  test('works without leading/trailing pipes', () => {
    const input = ['h1 | h2', '---|---', 'a | b'].join('\n')
    const expected = ['**`h1  h2`**', '`a   b `'].join('\n')
    expect(convertDiscordTables(input)).toBe(expected)
  })
})

describe('convertDiscordTables — multiple and mixed', () => {
  test('converts multiple tables in one document', () => {
    const input = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'separator prose',
      '',
      '| c | d |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n')

    const result = convertDiscordTables(input)
    expect(result).toContain('**`a  b`**')
    expect(result).toContain('**`c  d`**')
    expect(result).toContain('separator prose')
  })

  test('does not touch code fences that contain pipes', () => {
    const input = ['```', '| not | a | table |', '```'].join('\n')
    expect(convertDiscordTables(input)).toBe(input)
  })
})

describe('displayWidth', () => {
  test('counts ASCII as one column each', () => {
    expect(displayWidth('abc')).toBe(3)
  })

  test('counts CJK ideographs as two columns each', () => {
    expect(displayWidth('김철수')).toBe(6)
    expect(displayWidth('日本語')).toBe(6)
  })

  test('counts emoji as two columns', () => {
    expect(displayWidth('✅')).toBe(2)
  })

  test('ignores zero-width and combining marks', () => {
    expect(displayWidth('a\u0301')).toBe(1)
    expect(displayWidth('a\u200bb')).toBe(2)
  })

  test('mixes widths additively', () => {
    expect(displayWidth('a김b')).toBe(4)
  })
})

describe('convertDiscordTables — wide-character alignment', () => {
  test('aligns columns by VISUAL width, not code-unit length', () => {
    const input = ['| name | status |', '|------|--------|', '| 김철수 | ✅ ok |', '| bob | done |'].join('\n')

    const lines = convertDiscordTables(input).split('\n')
    const visualWidth = (line: string) =>
      displayWidth(line.replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/^`|`$/g, ''))

    const widths = lines.map(visualWidth)
    expect(new Set(widths).size).toBe(1)
  })

  test('a CJK cell wider than its header still aligns the body', () => {
    const input = ['| id | n |', '|----|---|', '| 1 | 김철수 |', '| 22 | x |'].join('\n')

    const lines = convertDiscordTables(input).split('\n')
    const visualWidth = (line: string) =>
      displayWidth(line.replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/^`|`$/g, ''))

    const widths = lines.map(visualWidth)
    expect(new Set(widths).size).toBe(1)
  })
})
