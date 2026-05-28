import { describe, expect, test } from 'bun:test'

import { normalizeRef } from './normalize-ref'

describe('normalizeRef', () => {
  test('strips the legacy `id=` prefix from Slack-style refs', () => {
    expect(normalizeRef('id=FABC123')).toBe('FABC123')
  })

  test('leaves bare ids untouched', () => {
    expect(normalizeRef('FABC123')).toBe('FABC123')
  })

  test('leaves URL refs untouched', () => {
    expect(normalizeRef('https://cdn.discordapp.com/attachments/c1/a1/diagram.png')).toBe(
      'https://cdn.discordapp.com/attachments/c1/a1/diagram.png',
    )
  })

  test('trims surrounding whitespace before checking the prefix', () => {
    expect(normalizeRef('  id=F1  ')).toBe('F1')
  })

  test('does not strip `id=` substrings that appear mid-ref', () => {
    expect(normalizeRef('https://example.com/x?id=abc')).toBe('https://example.com/x?id=abc')
  })
})
