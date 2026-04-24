import { describe, expect, test } from 'bun:test'

import { parseOpenSearch } from './wikipedia'

const REAL_RESPONSE = [
  'typescript',
  ['TypeScript', 'TypeScript syntax', 'Types Riot'],
  ['', '', ''],
  [
    'https://en.wikipedia.org/wiki/TypeScript',
    'https://en.wikipedia.org/wiki/TypeScript_syntax',
    'https://en.wikipedia.org/wiki/Types_Riot',
  ],
]

describe('parseOpenSearch', () => {
  test('zips parallel title/description/url arrays into structured results', () => {
    // when
    const results = parseOpenSearch(REAL_RESPONSE)

    // then
    expect(results).toEqual([
      { title: 'TypeScript', url: 'https://en.wikipedia.org/wiki/TypeScript', snippet: '' },
      { title: 'TypeScript syntax', url: 'https://en.wikipedia.org/wiki/TypeScript_syntax', snippet: '' },
      { title: 'Types Riot', url: 'https://en.wikipedia.org/wiki/Types_Riot', snippet: '' },
    ])
  })

  test('returns empty array on malformed responses', () => {
    expect(parseOpenSearch(null)).toEqual([])
    expect(parseOpenSearch({})).toEqual([])
    expect(parseOpenSearch(['only-query'])).toEqual([])
    expect(parseOpenSearch(['q', [], [], []])).toEqual([])
  })

  test('skips entries where title or url is missing', () => {
    const malformed = ['q', ['Good', '', 'Also Good'], ['', '', ''], ['https://a/', 'https://b/', '']]
    const results = parseOpenSearch(malformed)
    expect(results).toEqual([{ title: 'Good', url: 'https://a/', snippet: '' }])
  })

  test('preserves descriptions when Wikipedia provides them', () => {
    const withDescriptions = ['q', ['A'], ['Description of A'], ['https://a/']]
    const results = parseOpenSearch(withDescriptions)
    expect(results[0]?.snippet).toBe('Description of A')
  })
})
