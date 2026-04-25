import { describe, expect, test } from 'bun:test'

import { applyReadability } from './readability'

const ARTICLE = `
<!doctype html>
<html lang="en"><head><title>The Sample Article</title></head><body>
  <header><nav><a href="/">Home</a></nav></header>
  <article>
    <h1>The Sample Article</h1>
    <p>This is a paragraph of body text that is long enough for Readability to consider it main content. Readability heuristics generally need substantive prose to score an article highly.</p>
    <p>Here is a second paragraph that adds to the article body so the heuristics fire reliably across versions of @mozilla/readability.</p>
    <h2>Section</h2>
    <p>More body content with <a href="https://example.com/x">an example link</a> embedded inline.</p>
    <ul><li>First</li><li>Second</li></ul>
  </article>
  <footer>copyright</footer>
</body></html>`

describe('applyReadability', () => {
  test('extracts the article body and renders markdown headings, paragraphs, and lists', () => {
    const result = applyReadability(ARTICLE, 'https://example.com/post')

    expect(result).toMatch(/^# The Sample Article/)
    expect(result).toContain('paragraph of body text')
    expect(result).toContain('## Section')
    expect(result).toMatch(/-\s+First/)
    expect(result).toMatch(/-\s+Second/)
    expect(result).toContain('[an example link](https://example.com/x)')
  })

  test('does not include navigation or footer chrome', () => {
    const result = applyReadability(ARTICLE, 'https://example.com/post')
    expect(result).not.toContain('Home')
    expect(result).not.toContain('copyright')
  })

  test('returns a clear message when there is nothing to extract', () => {
    const result = applyReadability('<html><body></body></html>', 'https://example.com/empty')
    expect(result).toBe('Readability extracted no content from this page.')
  })
})
