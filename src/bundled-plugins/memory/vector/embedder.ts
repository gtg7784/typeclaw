import { join } from 'node:path'

import { env as transformersEnv, pipeline } from '@huggingface/transformers'

import { homeRoot } from '../../../hostd/paths'

export const MODEL_NAME = 'Xenova/multilingual-e5-base'
export const DIMS = 768

export type EmbedType = 'query' | 'passage'

type FeatureExtractor = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>

export class Embedder {
  private constructor(private readonly extractor: FeatureExtractor) {}

  static async load(): Promise<Embedder> {
    configureTransformers()
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

function configureTransformers(): void {
  transformersEnv.localModelPath = modelCachePath()
  transformersEnv.allowRemoteModels = false
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
