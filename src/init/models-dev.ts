import type { CustomModelMeta } from '@/config'
import {
  KNOWN_PROVIDERS,
  isKnownModelRef,
  isModelRef,
  listKnownModelRefs,
  providerForModelRef,
  type KnownProviderId,
  type ModelRef,
} from '@/config/providers'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const REQUEST_TIMEOUT_MS = 10_000

// models.dev keys providers by a string id that does NOT always match our
// KnownProviderId. Specifically, they ship Fireworks under `fireworks-ai`.
// This map is the single place that bridges the two namespaces; every other
// helper in this file works in OUR namespace.
const PROVIDER_TO_MODELS_DEV: Record<KnownProviderId, string> = {
  openai: 'openai',
  // openai-codex models live under the `openai` namespace on models.dev too
  // (Codex is a backend, not a separate provider in their taxonomy). Curated
  // entries are surfaced regardless of upstream membership.
  'openai-codex': 'openai',
  anthropic: 'anthropic',
  fireworks: 'fireworks-ai',
  zai: 'zai',
  // zai-coding (GLM Coding Plan) is a billing surface, not a separate model
  // catalog. models.dev tracks the underlying model metadata under `zai`,
  // so we route lookups there. The curated entries still get surfaced.
  'zai-coding': 'zai',
  xai: 'xai',
  minimax: 'minimax',
  deepseek: 'deepseek',
  // Upstage is not listed on models.dev (checked api.json — no `upstage` lab
  // entry, only HuggingFace open-model ids). Mapping to `upstage` is harmless:
  // the upstream lookup misses and the curated Solar entries surface anyway.
  upstage: 'upstage',
  moonshot: 'moonshot',
  // moonshot-coding (Kimi Code subscription) is a billing surface, not a
  // separate model catalog. models.dev tracks the underlying Kimi model
  // metadata under `moonshot`, so we route lookups there; the curated
  // `kimi-for-coding` alias is surfaced regardless of upstream membership.
  'moonshot-coding': 'moonshot',
}

export type ModelOption = {
  ref: ModelRef | string
  providerId: KnownProviderId
  providerName: string
  modelId: string
  modelName: string
  reasoning: boolean
  contextWindow: number | null
  maxTokens?: number | null
  cost?: ModelOptionCost | null
  curated: boolean
  // True iff the model accepts image input. Sourced from the curated
  // `Model.input` array (which is the source of truth — pi-ai consumes it
  // directly) with a fallback to models.dev's `modalities.input` when the
  // curated entry omits the field. The init wizard uses this to decide
  // whether to prompt for a separate `vision` profile after the user picks
  // a text-only `default` model.
  supportsVision: boolean
}

export type ModelOptionCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type ModelsDevModel = {
  id?: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  status?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    cache_read?: number
    cache_write?: number
  }
}

type ModelsDevProvider = {
  id?: string
  name?: string
  models?: Record<string, ModelsDevModel>
}

export type FetchModelsResult = {
  options: ModelOption[]
  source: 'models.dev' | 'curated'
  warning?: string
}

// Pulls the live model catalog from models.dev, intersects it with our
// curated KNOWN_PROVIDERS allowlist, and returns one ModelOption per
// (provider, model) pair the user is allowed to pick at init time.
//
// Falls back to the curated list alone if the network is unreachable, the
// response is malformed, or any unexpected error fires — the wizard MUST
// stay functional offline because `typeclaw init` is the very first thing a
// user does on a fresh machine, often before networking is sorted.
export async function fetchModelOptions(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  try {
    const res = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      return { options: curatedOptions(), source: 'curated', warning: `models.dev returned ${res.status}` }
    }
    const data = (await res.json()) as Record<string, ModelsDevProvider>
    return { options: mergeWithCurated(data), source: 'models.dev' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { options: curatedOptions(), source: 'curated', warning: reason }
  }
}

// The curated-only path: every model in KNOWN_PROVIDERS, sorted with the
// default model first so the picker can use index-0 as `initialValue`.
export function curatedOptions(): ModelOption[] {
  const refs = listKnownModelRefs()
  return refs.map((ref) => buildOption(ref, { curated: true }))
}

export function customModelMetaFromOption(option: ModelOption): CustomModelMeta | undefined {
  if (isKnownModelRef(option.ref)) return undefined
  if (!isModelRef(option.ref)) return undefined
  return {
    name: option.modelName,
    reasoning: option.reasoning,
    input: option.supportsVision ? ['text', 'image'] : ['text'],
    ...(option.contextWindow !== null ? { contextWindow: option.contextWindow } : {}),
    ...(option.maxTokens !== undefined && option.maxTokens !== null ? { maxTokens: option.maxTokens } : {}),
    ...(option.cost !== undefined && option.cost !== null ? { cost: option.cost } : {}),
  }
}

// `data` is the parsed models.dev JSON. We keep every curated entry first
// (including provider-specific aliases models.dev does not list), then append
// live upstream models whose refs validate against a known TypeClaw provider.
function mergeWithCurated(data: Record<string, ModelsDevProvider>): ModelOption[] {
  const out: ModelOption[] = []
  const seen = new Set<string>()
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    const known = KNOWN_PROVIDERS[providerId]
    const upstream = data[PROVIDER_TO_MODELS_DEV[providerId]]
    const upstreamModels = upstream?.models ?? {}
    for (const modelId of Object.keys(known.models)) {
      const upstreamModel = upstreamModels[modelId]
      const ref = `${providerId}/${modelId}`
      out.push(buildOption(ref, { curated: true, upstream: upstreamModel }))
      seen.add(ref)
    }
  }

  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    const upstream = data[PROVIDER_TO_MODELS_DEV[providerId]]
    const upstreamModels = upstream?.models ?? {}
    for (const [fallbackModelId, upstreamModel] of Object.entries(upstreamModels)) {
      const modelId = upstreamModel.id ?? fallbackModelId
      if (modelId.trim().length === 0) continue
      const ref = `${providerId}/${modelId}`
      if (seen.has(ref) || !isModelRef(ref)) continue
      out.push(buildOption(ref, { curated: isKnownModelRef(ref), upstream: upstreamModel }))
      seen.add(ref)
    }
  }
  return out
}

type BuildOptionOpts = {
  curated: boolean
  upstream?: ModelsDevModel
}

function buildOption(ref: ModelRef | string, opts: BuildOptionOpts): ModelOption {
  const providerId = providerForModelRef(ref)
  const modelId = ref.slice(providerId.length + 1)
  const provider = KNOWN_PROVIDERS[providerId]
  const curatedModel = (
    provider.models as Record<
      string,
      {
        name: string
        contextWindow?: number
        maxTokens?: number
        reasoning?: boolean
        input?: ReadonlyArray<string>
      }
    >
  )[modelId]
  const input = resolveInput(curatedModel?.input, opts.upstream?.modalities?.input)
  return {
    ref,
    providerId,
    providerName: provider.name,
    modelId,
    modelName: opts.upstream?.name ?? curatedModel?.name ?? modelId,
    reasoning: opts.upstream?.reasoning ?? curatedModel?.reasoning ?? false,
    contextWindow: opts.upstream?.limit?.context ?? curatedModel?.contextWindow ?? null,
    maxTokens: opts.upstream?.limit?.output ?? curatedModel?.maxTokens ?? null,
    cost: resolveCost(opts.upstream?.cost),
    curated: opts.curated,
    supportsVision: input.includes('image'),
  }
}

function resolveInput(
  curatedInput: ReadonlyArray<string> | undefined,
  upstreamInput: ReadonlyArray<string> | undefined,
): string[] {
  if (curatedInput !== undefined) return [...curatedInput]
  if (upstreamInput !== undefined && upstreamInput.length > 0) return [...upstreamInput]
  return ['text']
}

function resolveCost(cost: ModelsDevModel['cost']): ModelOptionCost | null {
  if (cost === undefined) return null
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? cost.cache_read ?? 0,
    cacheWrite: cost.cacheWrite ?? cost.cache_write ?? 0,
  }
}
