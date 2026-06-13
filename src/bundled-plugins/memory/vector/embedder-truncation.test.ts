import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { DIMS } from './embedder'
import { estimateTokens, TEXT_TOKEN_BUDGET } from './truncation'

let lastExtractorInput: string[] | undefined
let lastExtractorOptions: Record<string, unknown> | undefined

mock.module('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => {
    return (texts: string[], options?: Record<string, unknown>) => {
      lastExtractorInput = texts
      lastExtractorOptions = options
      const count = Array.isArray(texts) ? texts.length : 1
      return { data: new Float32Array(count * DIMS) }
    }
  },
}))

const overBudgetText = 'word '.repeat(TEXT_TOKEN_BUDGET * 4)

describe('embedder bounding', () => {
  test('extracts with mean pooling and normalized embeddings', async () => {
    const { embed } = await import('./embedder')

    await embed(['short passage'], 'passage')

    expect(lastExtractorOptions?.pooling).toBe('mean')
    expect(lastExtractorOptions?.normalize).toBe(true)
  })

  test('bounds an over-budget passage to the token budget before the extractor sees it', async () => {
    const { embed } = await import('./embedder')

    await embed([overBudgetText], 'passage')

    // The extractor input carries the "passage: " prefix; strip it before estimating.
    const seen = (lastExtractorInput ?? []).map((t) => t.replace(/^passage: /, ''))
    expect(seen).toHaveLength(1)
    expect(estimateTokens(seen[0] ?? '')).toBeLessThanOrEqual(TEXT_TOKEN_BUDGET)
  })

  test('passes an in-budget passage through unchanged', async () => {
    const { embed } = await import('./embedder')

    await embed(['a short belief sentence'], 'passage')

    expect(lastExtractorInput).toEqual(['passage: a short belief sentence'])
  })

  test('bounds an over-budget query too (no silent loss on the retrieval side)', async () => {
    const { embed } = await import('./embedder')

    await embed([overBudgetText], 'query')

    const seen = (lastExtractorInput ?? []).map((t) => t.replace(/^query: /, ''))
    expect(estimateTokens(seen[0] ?? '')).toBeLessThanOrEqual(TEXT_TOKEN_BUDGET)
  })
})

describe('embedder bounding observability', () => {
  let warnings: string[]
  const originalWarn = console.warn

  beforeEach(() => {
    warnings = []
    console.warn = (message?: unknown) => {
      warnings.push(String(message))
    }
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  test('warns content-free with the type and count when an input is bounded', async () => {
    const { embed } = await import('./embedder')

    await embed(['in budget', overBudgetText], 'query')

    const bounded = warnings.filter((w) => w.includes('bounded'))
    expect(bounded).toHaveLength(1)
    expect(bounded[0]).toContain('[memory]')
    expect(bounded[0]).toContain('query')
    expect(bounded[0]).toContain('1/2')
    expect(bounded[0]).not.toContain('word')
  })

  test('does not warn about bounding when every input is within budget', async () => {
    const { embed } = await import('./embedder')

    await embed(['short a', 'short b'], 'passage')

    expect(warnings.filter((w) => w.includes('bounded'))).toHaveLength(0)
  })
})

describe('embedder batch-size observability', () => {
  let warnings: string[]
  let notices: string[]
  const originalWarn = console.warn
  const originalInfo = console.info

  beforeEach(() => {
    warnings = []
    notices = []
    console.warn = (message?: unknown) => {
      warnings.push(String(message))
    }
    console.info = (message?: unknown) => {
      notices.push(String(message))
    }
  })

  afterEach(() => {
    console.warn = originalWarn
    console.info = originalInfo
  })

  test('logs the single-pass batch size at info for a small batch', async () => {
    const { embed } = await import('./embedder')

    await embed(['short a', 'short b'], 'passage')

    const batchLine = notices.find((n) => n.includes('in a single pass'))
    expect(batchLine).toContain('2 passage input(s)')
    expect(warnings.some((w) => w.includes('in a single pass'))).toBe(false)
  })

  test('warns when the single-pass batch is large enough to risk an OOM-killed boot', async () => {
    const { embed } = await import('./embedder')

    await embed(
      Array.from({ length: 256 }, (_, i) => `passage ${i}`),
      'passage',
    )

    const batchWarn = warnings.find((w) => w.includes('in a single pass'))
    expect(batchWarn).toContain('256 passage input(s)')
    expect(batchWarn).toContain('OOM')
  })
})
