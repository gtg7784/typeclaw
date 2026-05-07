import { describe, expect, test } from 'bun:test'

import { chunkMarkdown } from './chunk'

describe('chunkMarkdown — basic invariants', () => {
  test('empty input returns single empty chunk', () => {
    expect(chunkMarkdown('', 100)).toEqual([''])
  })

  test('input under maxLen returns single chunk verbatim', () => {
    const text = 'short message'
    expect(chunkMarkdown(text, 100)).toEqual([text])
  })

  test('throws on non-positive maxLen', () => {
    expect(() => chunkMarkdown('x', 0)).toThrow()
    expect(() => chunkMarkdown('x', -1)).toThrow()
    expect(() => chunkMarkdown('x', Number.NaN)).toThrow()
    expect(() => chunkMarkdown('x', Number.POSITIVE_INFINITY)).toThrow()
  })

  test('every chunk respects maxLen for prose-only input', () => {
    const para = 'This is a sentence. '.repeat(500)
    const chunks = chunkMarkdown(para, 200)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200)
    }
  })

  test('output never contains empty chunks (except for empty input)', () => {
    const chunks = chunkMarkdown('a\n\nb\n\nc\n\nd\n\ne'.repeat(50), 60)
    for (const chunk of chunks) {
      expect(chunk).not.toBe('')
    }
  })
})

describe('chunkMarkdown — paragraph splitting', () => {
  test('two paragraphs over limit split at \\n\\n boundary', () => {
    const a = 'A'.repeat(50)
    const b = 'B'.repeat(50)
    const text = `${a}\n\n${b}`
    const chunks = chunkMarkdown(text, 60)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe(a)
    expect(chunks[1]).toBe(b)
  })

  test('three paragraphs pack greedily', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const c = 'c'.repeat(40)
    const chunks = chunkMarkdown(`${a}\n\n${b}\n\n${c}`, 100)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe(`${a}\n\n${b}`)
    expect(chunks[1]).toBe(c)
  })

  test('long single paragraph splits on line boundaries', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} `.repeat(10).trim())
    const text = lines.join('\n')
    const chunks = chunkMarkdown(text, 200)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200)
    }
    expect(chunks.length).toBeGreaterThan(1)
  })

  test('long single line splits on sentences', () => {
    const sentence = 'This is a sentence with some content. '
    const text = sentence.repeat(20).trim()
    const chunks = chunkMarkdown(text, 100)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100)
    }
  })

  test('extremely long token falls back to hard cut', () => {
    const text = 'x'.repeat(500)
    const chunks = chunkMarkdown(text, 100)
    expect(chunks).toHaveLength(5)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100)
    }
  })
})

describe('chunkMarkdown — code fence preservation', () => {
  test('code fence at chunk boundary stays whole', () => {
    const before = 'p'.repeat(80)
    const fence = '```\nconst x = 1\nconst y = 2\n```'
    const after = 'q'.repeat(80)
    const text = `${before}\n\n${fence}\n\n${after}`
    const chunks = chunkMarkdown(text, 120)
    const fenceChunkCount = chunks.filter((c) => c.includes(fence)).length
    expect(fenceChunkCount).toBe(1)
  })

  test('pipe characters inside code fence do not trigger table detection', () => {
    const fence = '```\n| not | a | table |\n|---|---|---|\n| 1 | 2 | 3 |\n```'
    const chunks = chunkMarkdown(fence, 1000)
    expect(chunks).toEqual([fence])
  })

  test('oversize code fence splits with reopened fence on each chunk', () => {
    const innerLines = Array.from({ length: 50 }, (_, i) => `line${i} content here`)
    const fence = ['```ts', ...innerLines, '```'].join('\n')
    const chunks = chunkMarkdown(fence, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith('```ts\n') || chunk.startsWith('```ts')).toBe(true)
      expect(chunk.endsWith('\n```')).toBe(true)
      expect(chunk.length).toBeLessThanOrEqual(200)
    }
  })

  test('tilde fences are recognized', () => {
    const fence = '~~~js\nfoo()\nbar()\n~~~'
    expect(chunkMarkdown(fence, 100)).toEqual([fence])
  })
})

describe('chunkMarkdown — table preservation', () => {
  test('table at chunk boundary stays whole', () => {
    const before = 'p'.repeat(80)
    const table = '| col1 | col2 |\n|------|------|\n| a    | b    |\n| c    | d    |'
    const after = 'q'.repeat(80)
    const chunks = chunkMarkdown(`${before}\n\n${table}\n\n${after}`, 120)
    const tableChunks = chunks.filter((c) => c.includes('|------|'))
    expect(tableChunks).toHaveLength(1)
    expect(tableChunks[0]).toContain('| col1 | col2 |')
    expect(tableChunks[0]).toContain('| c    | d    |')
  })

  test('two consecutive tables pack independently', () => {
    const t1 = '| a | b |\n|---|---|\n| 1 | 2 |'
    const t2 = '| c | d |\n|---|---|\n| 3 | 4 |'
    const chunks = chunkMarkdown(`${t1}\n\n${t2}`, 200)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain(t1)
    expect(chunks[0]).toContain(t2)
  })

  test('oversize table is emitted whole as single chunk (documented behavior)', () => {
    const rows = Array.from({ length: 100 }, (_, i) => `| ${i} | data${i} |`)
    const table = ['| col | val |', '|-----|-----|', ...rows].join('\n')
    const chunks = chunkMarkdown(table, 200)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(table)
  })

  test('paragraph followed by table: paragraph splits, table whole', () => {
    const para = 'P'.repeat(150)
    const table = '| a | b |\n|---|---|\n| 1 | 2 |'
    const chunks = chunkMarkdown(`${para}\n\n${table}`, 100)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    const tableChunkCount = chunks.filter((c) => c.includes('|---|')).length
    expect(tableChunkCount).toBe(1)
  })

  test('prose with leading pipes that is NOT a table is split as prose', () => {
    const text = '| this looks like a row but has no separator\nanother line | with pipe'
    const chunks = chunkMarkdown(text, 1000)
    expect(chunks).toEqual([text])
  })
})

describe('chunkMarkdown — blockquote preservation', () => {
  test('blockquote at boundary stays whole', () => {
    const before = 'p'.repeat(80)
    const quote = '> line one\n> line two\n> line three'
    const after = 'q'.repeat(80)
    const chunks = chunkMarkdown(`${before}\n\n${quote}\n\n${after}`, 120)
    const quoteChunks = chunks.filter((c) => c.includes('> line two'))
    expect(quoteChunks).toHaveLength(1)
    expect(quoteChunks[0]).toContain('> line one')
    expect(quoteChunks[0]).toContain('> line three')
  })
})

describe('chunkMarkdown — list handling', () => {
  test('long list splits between items', () => {
    const items = Array.from({ length: 20 }, (_, i) => `- item ${i}`)
    const text = items.join('\n')
    const chunks = chunkMarkdown(text, 50)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50)
      const lines = chunk.split('\n')
      for (const line of lines) {
        expect(line.startsWith('- ')).toBe(true)
      }
    }
  })

  test('numbered list works the same way', () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. step ${i}`)
    const text = items.join('\n')
    const chunks = chunkMarkdown(text, 30)
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe('chunkMarkdown — content preservation', () => {
  test('all non-whitespace content survives chunking (no data loss)', () => {
    const para = 'word '.repeat(100)
    const fence = '```\ncode line\n```'
    const table = '| a | b |\n|---|---|\n| 1 | 2 |'
    const text = `${para}\n\n${fence}\n\n${table}\n\n${para}`
    const chunks = chunkMarkdown(text, 200)
    const rejoined = chunks.join('\n').replace(/\s+/g, ' ').trim()
    const original = text.replace(/\s+/g, ' ').trim()
    expect(rejoined).toBe(original)
  })

  test('fence-with-reopen preserves all inner content', () => {
    const inner = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const fence = `\`\`\`ts\n${inner}\n\`\`\``
    const chunks = chunkMarkdown(fence, 100)
    const innerRejoined = chunks
      .map((c) => c.replace(/^```ts\n/, '').replace(/\n```$/, ''))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
    expect(innerRejoined).toBe(inner.replace(/\s+/g, ' ').trim())
  })
})
