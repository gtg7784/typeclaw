import { describe, expect, mock, test } from 'bun:test'

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
