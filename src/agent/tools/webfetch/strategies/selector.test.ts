import { describe, expect, test } from 'bun:test'

import { applySelector, SelectorError } from './selector'

const HTML = `
<html><body>
  <h1>Title</h1>
  <ul class="list">
    <li class="item">Apple</li>
    <li class="item">Banana</li>
    <li class="item">Cherry</li>
  </ul>
  <span class="price">$9.99</span>
</body></html>`

describe('applySelector', () => {
  test('extracts text from matching elements', () => {
    const result = applySelector(HTML, '.item')
    expect(result).toContain('Matched 3 element(s) for ".item"')
    expect(result).toContain('[1] Apple')
    expect(result).toContain('[2] Banana')
    expect(result).toContain('[3] Cherry')
  })

  test('returns no-match message when selector finds nothing', () => {
    expect(applySelector(HTML, '.nope')).toBe('No elements matched selector: .nope')
  })

  test('targets a single element', () => {
    const result = applySelector(HTML, '.price')
    expect(result).toContain('[1] $9.99')
  })

  test('throws SelectorError on invalid CSS selector', () => {
    expect(() => applySelector(HTML, ':::')).toThrow(SelectorError)
  })
})
