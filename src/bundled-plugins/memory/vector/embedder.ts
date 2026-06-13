import { join } from 'node:path'

// Type-only import: erased at runtime, so it does NOT evaluate
// @huggingface/transformers (which eagerly `import sharp`s, crashing the
// container at startup when sharp's linux binary is missing). The runtime
// values are pulled lazily via `loadTransformers()` below.
import type { env as TransformersEnvValue, pipeline as TransformersPipeline } from '@huggingface/transformers'

import {
  assertModelCacheCompatible,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL_DTYPE,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_NAME,
} from '@/models/embedding-model'
import { getResolvedTransformersVersion } from '@/models/transformers-version'

import { homeRoot } from '../../../hostd/paths'
import { type BoundedText, boundEmbeddableText, MAX_MODEL_TOKENS } from './truncation'

// Re-exported for the vector subsystem's existing imports. The canonical
// definitions live in @/models/embedding-model (shared host + container).
export const MODEL_NAME = EMBEDDING_MODEL_NAME
export const DIMS = EMBEDDING_DIMS
export const MODEL_DTYPE = EMBEDDING_MODEL_DTYPE
export { EMBEDDING_MODEL_ID }

export type EmbedType = 'query' | 'passage'

// Passages per onnxruntime forward pass. The whole-array embed (a startup index
// build over thousands of shards+fragments) otherwise allocates activation
// tensors for every input at once, and that single spike OOM-kills the
// container mid-build — the agent boots, then dies with only a SIGKILL. Chunking
// caps peak memory at one batch's worth regardless of corpus size; the model is
// loaded once and reused across chunks, so the only cost is sequential passes.
const EMBED_BATCH_SIZE = 64

type TransformersEnv = typeof TransformersEnvValue
type FeatureExtractor = Awaited<ReturnType<typeof TransformersPipeline<'feature-extraction'>>>

// Defer the transformers (and thus sharp/onnxruntime) module load until an
// embedding is actually requested. typeclaw's memory plugin is always loaded
// and `vector.enabled` defaults to false, so a top-level static import would
// drag the heavy native stack onto every container boot — and crash it when
// sharp can't resolve its platform binary. Memoized so the module evaluates
// at most once.
type TransformersModule = { env: TransformersEnv; pipeline: typeof TransformersPipeline }

let transformersModulePromise: Promise<TransformersModule> | undefined

const realTransformersImport = (): Promise<TransformersModule> =>
  import('@huggingface/transformers').then((mod) => ({ env: mod.env, pipeline: mod.pipeline }))

// Injectable importer seam. Defaults to the real dynamic import; a test can
// swap it to drive the module-load layer (e.g. fail once, then succeed) without
// fighting Bun's mock.module namespace snapshotting. Bun freezes the mocked
// namespace at registration, so a runtime-toggled failure can't be expressed
// through mock.module — this seam is the supported way to exercise it.
let importTransformers: () => Promise<TransformersModule> = realTransformersImport

export function __setTransformersImporterForTests(importer: (() => Promise<TransformersModule>) | undefined): void {
  importTransformers = importer ?? realTransformersImport
  transformersModulePromise = undefined
}

// Injectable cache-compatibility check, mirroring the importer seam above. In
// production it asserts the host-stamped sentinel matches this container before
// the local_files_only load. The embedder's own mechanics tests (batching,
// lazy-load, warm-up) mock transformers and run against the default cache path
// with no sentinel, so they swap in a no-op — the sentinel guard has its own
// dedicated coverage in embedding-model.test.ts.
const realModelCacheCheck = (): Promise<void> =>
  assertModelCacheCompatible(modelCachePath(), { transformers: getResolvedTransformersVersion() })

let verifyModelCache: () => Promise<void> = realModelCacheCheck

export function __setModelCacheCheckForTests(check: (() => Promise<void>) | undefined): void {
  verifyModelCache = check ?? realModelCacheCheck
}

function loadTransformers(): Promise<TransformersModule> {
  // Clear the memo on rejection (mirroring getEmbedder) so a transient failure
  // of the dynamic import / native module load doesn't cache the rejected
  // promise — otherwise every later getEmbedder() awaits the same dead promise
  // and per-turn embedding stays poisoned for the life of the process.
  transformersModulePromise ??= importTransformers().catch((err) => {
    transformersModulePromise = undefined
    throw err
  })
  return transformersModulePromise
}

export class Embedder {
  private constructor(private readonly extractor: FeatureExtractor) {}

  static async load(): Promise<Embedder> {
    const { env, pipeline } = await loadTransformers()
    // Guard the cache BEFORE local_files_only load: a host/container transformers
    // drift (or a hand-copied cache) otherwise surfaces as a cryptic missing-file
    // miss, or silently loads a stale variant. Fails loudly with a refresh hint.
    await verifyModelCache()
    configureTransformers(env)
    const extractor = await pipeline('feature-extraction', MODEL_NAME, { local_files_only: true, dtype: MODEL_DTYPE })
    return new Embedder(extractor)
  }

  async embed(texts: string[], type: EmbedType): Promise<Float32Array[]> {
    if (texts.length === 0) return []

    // Bound every input to the model's token budget BEFORE the tokenizer sees it.
    // The tokenizer would otherwise truncate silently at 512 tokens; bounding
    // here makes the cut deterministic and owned by us (the leading heading /
    // belief sentence — the load-bearing retrieval signal — always survives
    // because it comes first). The dreaming subagent separately compacts the
    // topic shards that trip this, but bounding guarantees no silent loss even
    // for inputs dreaming never rewrites — queries and stream fragments — which
    // the dreaming over_budget table does not cover, so this is their only
    // observability path.
    const results = texts.map((text) => boundEmbeddableText(text))
    warnIfBounded(results, type)

    // Log the total embed size up front so a process that dies mid-build still
    // leaves a line naming how much it was embedding. The work is chunked below
    // (EMBED_BATCH_SIZE per onnxruntime pass) so peak memory no longer scales
    // with this total — but the count remains the useful breadcrumb for a slow
    // or wedged build.
    logEmbedBatch(texts.length, type)

    const prefixed = prefixTexts(
      results.map((r) => r.text),
      type,
    )

    // Gate per-chunk progress on the same LARGE_EMBED threshold as the up-front
    // line: only the startup index migration runs long enough for "wedged or
    // just slow?" to be a real question. Smaller embeds (queries, per-write
    // upserts) finish in a pass or two and would only spam the logs.
    const reportProgress = prefixed.length >= LARGE_EMBED

    const embeddings: Float32Array[] = []
    for (let start = 0; start < prefixed.length; start += EMBED_BATCH_SIZE) {
      const batch = prefixed.slice(start, start + EMBED_BATCH_SIZE)
      const output = await this.extractor(batch, { pooling: 'mean', normalize: true })
      embeddings.push(...toEmbeddings(output.data, batch.length))
      if (reportProgress) logEmbedProgress(embeddings.length, prefixed.length, type)
    }
    return embeddings
  }
}

let embedderInstance: Promise<Embedder> | null = null

export function getEmbedder(): Promise<Embedder> {
  // Clear the memo on rejection so a transient load failure (e.g. boot warm-up
  // racing the host model mount) degrades to a retry on the next call instead
  // of caching the rejected promise and poisoning every later per-turn embed.
  embedderInstance ??= Embedder.load().catch((err) => {
    embedderInstance = null
    throw err
  })
  return embedderInstance
}

// Boot-time readiness step: force the lazy embedder to load now so the first
// per-turn query embed doesn't pay the ~2-5s ONNX init on the critical path.
// Only called on the vector-enabled boot path (see src/run/index.ts), which
// preserves embedder.ts's lazy-import guarantee for vector-off boots.
export async function warmEmbedder(): Promise<void> {
  await getEmbedder()
}

export async function embed(texts: string[], type: EmbedType): Promise<Float32Array[]> {
  return (await getEmbedder()).embed(texts, type)
}

// Structured, content-free signal when any input was bounded, so a truncation
// is observable in logs (the dreaming over_budget table only covers topic
// shards — this is the only path for queries and stream fragments). Logs counts
// and the worst estimate only, never the text, so memory content can't leak.
function warnIfBounded(results: readonly BoundedText[], type: EmbedType): void {
  const trimmed = results.filter((r) => r.bounded)
  if (trimmed.length === 0) return
  const worst = trimmed.reduce((max, r) => Math.max(max, r.estimatedTokens), 0)
  console.warn(
    `[memory] vector embedding: bounded ${trimmed.length}/${results.length} ${type} input(s) to the ` +
      `${MAX_MODEL_TOKENS}-token model limit (worst ~${worst} est. tokens); their tail is not embedded`,
  )
}

// A large embed (a startup index build over thousands of passages) used to be
// the prime suspect for a container that boots, logs, then dies without an
// error — the onnxruntime activation tensors spiked the OOM killer. The embed
// is now chunked at EMBED_BATCH_SIZE, so this is no longer a fatal threshold;
// it just marks where a build is large enough that its duration is worth noting
// up front (the count remains the breadcrumb if the build wedges or is slow).
const LARGE_EMBED = 256

function logEmbedBatch(count: number, type: EmbedType): void {
  const line = `[memory] vector embedding: ${count} ${type} input(s) (chunked at ${EMBED_BATCH_SIZE}/pass)`
  if (count >= LARGE_EMBED) {
    console.info(`${line} — large build, this may take a while`)
  } else {
    console.info(line)
  }
}

function logEmbedProgress(done: number, total: number, type: EmbedType): void {
  const pct = Math.floor((done / total) * 100)
  console.info(`[memory] vector embedding: ${done}/${total} ${type} input(s) embedded (${pct}%)`)
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
