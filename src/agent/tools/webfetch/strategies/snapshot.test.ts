import { describe, expect, test } from 'bun:test'

import { applySnapshot } from './snapshot'

describe('applySnapshot', () => {
  test('emits an indented semantic tree of headings, links, and forms', () => {
    const html = `
<html><body>
  <header><h1>Welcome</h1></header>
  <nav><a href="/about">About</a></nav>
  <main>
    <article><h2>Post Title</h2><p>body</p></article>
    <form>
      <label>Email</label>
      <input type="email" name="email" placeholder="you@example.com">
      <button>Submit</button>
    </form>
  </main>
</body></html>`

    const result = applySnapshot(html)

    expect(result).toContain('- banner')
    expect(result).toContain('- heading: Welcome')
    expect(result).toContain('- navigation')
    expect(result).toContain('- link: "About" → /about')
    expect(result).toContain('- main')
    expect(result).toContain('- article')
    expect(result).toContain('- heading: Post Title')
    expect(result).toContain('- form')
    expect(result).toContain('- label: Email')
    expect(result).toContain('type=email')
    expect(result).toContain('name=email')
    expect(result).toContain('- button: Submit')
  })

  test('returns a clear message when no semantic structure exists', () => {
    expect(applySnapshot('<html><body><script>void 0</script></body></html>')).toBe(
      'Page contains no semantic structure.',
    )
  })

  test('produces hierarchical indentation', () => {
    const html = '<html><body><main><section><h1>Inside</h1></section></main></body></html>'
    const result = applySnapshot(html)
    const lines = result.split('\n')
    const main = lines.find((l) => l.includes('main'))
    const section = lines.find((l) => l.includes('section'))
    const heading = lines.find((l) => l.includes('heading'))
    expect(main?.startsWith('- main')).toBe(true)
    expect(section?.startsWith('  - section')).toBe(true)
    expect(heading?.startsWith('    - heading')).toBe(true)
  })
})
