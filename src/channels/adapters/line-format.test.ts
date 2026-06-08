import { describe, expect, test } from 'bun:test'

import { toLinePlainText } from './line-format'

describe('toLinePlainText', () => {
  test('strips bold and heading markers', () => {
    expect(toLinePlainText('**bold** text')).toBe('bold text')
    expect(toLinePlainText('## Heading')).toBe('Heading')
  })

  test('collapses a link to label plus url', () => {
    expect(toLinePlainText('[docs](https://example.com)')).toBe('docs (https://example.com)')
  })

  test('keeps fenced code body without the fences', () => {
    expect(toLinePlainText('```\ncode line\n```')).toBe('code line')
  })

  test('leaves plain text untouched', () => {
    expect(toLinePlainText('just a normal message')).toBe('just a normal message')
  })
})
