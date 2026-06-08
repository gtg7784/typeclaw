import { KNOWN_PROVIDERS, type KnownModelRef, type KnownProviderId, listKnownModelRefs } from '@/config/providers'

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
}

export type ModelOption = {
  ref: KnownModelRef
  providerId: KnownProviderId
  providerName: string
  modelId: string
  modelName: string
  reasoning: boolean
  contextWindow: number | null
  curated: boolean
  // True iff the model accepts image input. Sourced from the curated
  // `Model.input` array (which is the source of truth — pi-ai consumes it
  // directly) with a fallback to models.dev's `modalities.input` when the
  // curated entry omits the field. The init wizard uses this to decide
  // whether to prompt for a separate `vision` profile after the user picks
  // a text-only `default` model.
  supportsVision: boolean
}

type ModelsDevModel = {
  id?: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  status?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number }
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

// `data` is the parsed models.dev JSON. We walk only the providers we care
// about (openai, fireworks-ai) and only emit options for models that are
// also in our curated allowlist — anything outside the allowlist would fail
// schema validation when written to typeclaw.json. Curated entries that
// models.dev doesn't list (e.g. kimi-k2p6-turbo) are still surfaced so the
// user can pick them.
function mergeWithCurated(data: Record<string, ModelsDevProvider>): ModelOption[] {
  const out: ModelOption[] = []
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    const known = KNOWN_PROVIDERS[providerId]
    const upstream = data[PROVIDER_TO_MODELS_DEV[providerId]]
    const upstreamModels = upstream?.models ?? {}
    for (const modelId of Object.keys(known.models)) {
      const upstreamModel = upstreamModels[modelId]
      const ref = `${providerId}/${modelId}` as KnownModelRef
      out.push(buildOption(ref, { curated: true, upstream: upstreamModel }))
    }
  }
  return out
}

type BuildOptionOpts = {
  curated: boolean
  upstream?: ModelsDevModel
}

function buildOption(ref: KnownModelRef, opts: BuildOptionOpts): ModelOption {
  const slash = ref.indexOf('/')
  const providerId = ref.slice(0, slash) as KnownProviderId
  const modelId = ref.slice(slash + 1)
  const provider = KNOWN_PROVIDERS[providerId]
  const curatedModel = (
    provider.models as Record<
      string,
      { name: string; contextWindow?: number; reasoning?: boolean; input?: ReadonlyArray<string> }
    >
  )[modelId]
  return {
    ref,
    providerId,
    providerName: provider.name,
    modelId,
    modelName: opts.upstream?.name ?? curatedModel?.name ?? modelId,
    reasoning: opts.upstream?.reasoning ?? curatedModel?.reasoning ?? false,
    contextWindow: opts.upstream?.limit?.context ?? curatedModel?.contextWindow ?? null,
    curated: opts.curated,
    supportsVision: resolveSupportsVision(curatedModel?.input, opts.upstream?.modalities?.input),
  }
}

function resolveSupportsVision(
  curatedInput: ReadonlyArray<string> | undefined,
  upstreamInput: ReadonlyArray<string> | undefined,
): boolean {
  if (curatedInput !== undefined) return curatedInput.includes('image')
  if (upstreamInput !== undefined) return upstreamInput.includes('image')
  return false
}
