import { describe, expect, test } from 'bun:test'

import { applyRaw } from './raw'

describe('applyRaw', () => {
  test('returns input unchanged', () => {
    expect(applyRaw('hello\nworld')).toBe('hello\nworld')
    expect(applyRaw('')).toBe('')
    expect(applyRaw('<html>foo</html>')).toBe('<html>foo</html>')
  })
})
