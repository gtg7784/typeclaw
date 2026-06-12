import { join } from 'node:path'

// Type-only import: erased at runtime, so it does NOT evaluate
// @huggingface/transformers (which eagerly `import sharp`s, crashing the
// container at startup when sharp's linux binary is missing). The runtime
// values are pulled lazily via `loadTransformers()` below.
import type { env as TransformersEnvValue, pipeline as TransformersPipeline } from '@huggingface/transformers'

import { homeRoot } from '../../../hostd/paths'

export const MODEL_NAME = 'Xenova/multilingual-e5-base'
export const DIMS = 768

export type EmbedType = 'query' | 'passage'

type TransformersEnv = typeof TransformersEnvValue
type FeatureExtractor = Awaited<ReturnType<typeof TransformersPipeline<'feature-extraction'>>>

// Defer the transformers (and thus sharp/onnxruntime) module load until an
// embedding is actually requested. typeclaw's memory plugin is always loaded
// and `vector.enabled` defaults to false, so a top-level static import would
// drag the heavy native stack onto every container boot — and crash it when
// sharp can't resolve its platform binary. Memoized so the module evaluates
// at most once.
let transformersModulePromise: Promise<{ env: TransformersEnv; pipeline: typeof TransformersPipeline }> | undefined

function loadTransformers(): Promise<{ env: TransformersEnv; pipeline: typeof TransformersPipeline }> {
  transformersModulePromise ??= import('@huggingface/transformers').then((mod) => ({
    env: mod.env,
    pipeline: mod.pipeline,
  }))
  return transformersModulePromise
}

export class Embedder {
  private constructor(private readonly extractor: FeatureExtractor) {}

  static async load(): Promise<Embedder> {
    const { env, pipeline } = await loadTransformers()
    configureTransformers(env)
    const extractor = await pipeline('feature-extraction', MODEL_NAME, { local_files_only: true })
    return new Embedder(extractor)
  }

  async embed(texts: string[], type: EmbedType): Promise<Float32Array[]> {
    if (texts.length === 0) return []

    const output = await this.extractor(prefixTexts(texts, type), { pooling: 'mean', normalize: true })
    return toEmbeddings(output.data, texts.length)
  }
}

let embedderInstance: Promise<Embedder> | null = null

export function getEmbedder(): Promise<Embedder> {
  embedderInstance ??= Embedder.load()
  return embedderInstance
}

export async function embed(texts: string[], type: EmbedType): Promise<Float32Array[]> {
  return (await getEmbedder()).embed(texts, type)
}

function configureTransformers(env: TransformersEnv): void {
  env.localModelPath = modelCachePath()
  env.allowRemoteModels = false
}

function modelCachePath(): string {
  const override = process.env.TYPECLAW_MODEL_CACHE
  if (override && override.length > 0) return override
  return join(homeRoot(), 'models')
}

function prefixTexts(texts: string[], type: EmbedType): string[] {
  const prefix = type === 'query' ? 'query: ' : 'passage: '
  return texts.map((text) => `${prefix}${text}`)
}

function toEmbeddings(data: unknown, count: number): Float32Array[] {
  const values = toFloat32Array(data)
  if (values.length !== count * DIMS) {
    throw new Error(`unexpected ${MODEL_NAME} embedding size: got ${values.length}, expected ${count * DIMS}`)
  }

  return Array.from({ length: count }, (_, index) => values.slice(index * DIMS, (index + 1) * DIMS))
}

function toFloat32Array(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data
  if (!isNumericArrayLike(data)) throw new Error(`${MODEL_NAME} returned non-numeric embeddings`)
  return Float32Array.from(data)
}

function isNumericArrayLike(data: unknown): data is ArrayLike<number> {
  if (!ArrayBuffer.isView(data) || !('length' in data)) return false
  return !(data instanceof BigInt64Array) && !(data instanceof BigUint64Array)
}
