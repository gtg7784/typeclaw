import { beforeAll, describe, expect, mock, test } from 'bun:test'

// Regression guard for the container-boot crash: `@huggingface/transformers`
// eagerly `import sharp`s at module-evaluation time, and the memory plugin
// (which imports the embedder transitively) is always loaded with
// `vector.enabled` defaulting to false. If embedder.ts ever goes back to a
// top-level `import { env, pipeline } from '@huggingface/transformers'`, the
// transformers module would evaluate the moment embedder.ts is imported —
// dragging sharp onto every boot and crashing the container. This test proves
// the import is deferred to first embed.
let transformersEvaluated = false
let lastPipelineOptions: Record<string, unknown> | undefined

mock.module('@huggingface/transformers', () => {
  transformersEvaluated = true
  return {
    env: {},
    pipeline: async (_task: string, _model: string, options?: Record<string, unknown>) => {
      lastPipelineOptions = options
      const extractor = () => ({ data: new Float32Array(768) })
      return extractor
    },
  }
})

describe('embedder lazy transformers load', () => {
  // Importing the module to set the seam does NOT evaluate transformers (that is
  // exactly what the first test asserts) — the cache check is a separate concern
  // with its own coverage, so a no-op keeps these tests off a real model cache.
  beforeAll(async () => {
    const mod = await import('./embedder')
    mod.__setModelCacheCheckForTests(() => Promise.resolve())
  })

  test('importing the embedder module does NOT evaluate @huggingface/transformers', async () => {
    await import('./embedder')
    expect(transformersEvaluated).toBe(false)
  })

  test('@huggingface/transformers is evaluated only when an embedding is actually requested', async () => {
    const { getEmbedder } = await import('./embedder')
    expect(transformersEvaluated).toBe(false)

    await getEmbedder()
    expect(transformersEvaluated).toBe(true)
  })

  test('loads the q8 variant locally (dtype pinned, local_files_only preserved)', async () => {
    const { getEmbedder } = await import('./embedder')

    await getEmbedder()

    expect(lastPipelineOptions?.dtype).toBe('q8')
    expect(lastPipelineOptions?.local_files_only).toBe(true)
  })
})
