// Compatibility shim for adaptive-thinking-only Anthropic models on the
// pinned pi stack (@mariozechner/* 0.73.x).
//
// The problem: Sonnet 5 and Fable 5 accept ONLY adaptive thinking. Manual
// extended thinking (`thinking: {type: "enabled"}` with `budget_tokens`)
// returns a 400. But pi-ai's `supportsAdaptiveThinking()` matches only
// 4.6-generation ids (`opus-4-6`, `sonnet-4-6`), so for any OTHER Anthropic
// model registered with `reasoning: true` it falls back to the budget-based
// path — and thinking is on by default (pi-coding-agent's
// DEFAULT_THINKING_LEVEL is "medium", and `defaultThinkingLevelForRef`
// deliberately defers to it). Net effect without this shim: a session on
// Sonnet 5 / Fable 5 400s on its first request. Still true on 0.73.1: pi-ai
// 0.73.1 does not force adaptive thinking for these ids, so bumping the
// @mariozechner/* stack to 0.73 (PR #1123) did not obviate this shim.
//
// The fix: pi-ai calls `options.onPayload(params, model)` right before the
// HTTP request and adopts a non-undefined return value as the request params
// (see `streamAnthropic` in pi-ai's providers/anthropic.ts). We hook that seam
// via `Agent.onPayload` — a public field, same seam `src/agent/index.ts`
// already uses for `convertToLlm` (the replay sanitizer) — and rewrite
// `thinking: {type: "enabled", ...}` to `thinking: {type: "adaptive"}` for
// exactly the adaptive-only model ids. Everything else passes through
// byte-identical.
//
// Not covered (deliberately): pi-ai also sends the
// `interleaved-thinking-2025-05-14` beta header for non-4.6 models. That
// header is set at SDK-client construction, before `onPayload` runs, so this
// shim can't remove it — it is redundant-but-harmless on adaptive models (the
// API ignores it), unlike the budget `thinking` payload which hard-fails.
//
// TODO(pi-migration): DELETE THIS FILE when typeclaw migrates off the
// @mariozechner/pi-* 0.73.x line to @earendil-works/pi-* >= 0.80 (the same
// maintainers' scope rename; @mariozechner ends at 0.73.1, @earendil-works
// starts at 0.74.0). As of @earendil-works/pi-ai 0.80.3 the sonnet-5 / fable-5
// model records carry `compat: { forceAdaptiveThinking: true }`, and the
// Anthropic transport reads that flag to emit `thinking: {type: "adaptive"}`
// itself (AnthropicMessagesCompat.forceAdaptiveThinking) — so on that stack the
// rewrite here becomes redundant and both this file and its `onPayload` wiring
// in `src/agent/index.ts` should be removed.

import type { Api, Model } from '@mariozechner/pi-ai'

type OnPayload = (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>

type OnPayloadHost = { onPayload?: OnPayload }

// Mirrors pi-ai's own id matching style (`String.includes`, date-suffix
// tolerant). Scoped to the Anthropic Messages API so a same-named id on a
// different transport (e.g. a Bedrock alias) is never touched.
export function isAdaptiveOnlyAnthropicModel(model: Pick<Model<Api>, 'api' | 'id'>): boolean {
  if (model.api !== 'anthropic-messages') return false
  return model.id.includes('sonnet-5') || model.id.includes('fable-5')
}

// Pure rewrite: budget-based `thinking` -> `{type: "adaptive"}` for
// adaptive-only models. Returns the ORIGINAL payload object (not a clone)
// whenever no rewrite applies, so "untouched" is reference-checkable in tests.
export function rewriteThinkingForAdaptiveOnlyModels(payload: unknown, model: Pick<Model<Api>, 'api' | 'id'>): unknown {
  if (!isAdaptiveOnlyAnthropicModel(model)) return payload
  if (payload === null || typeof payload !== 'object') return payload
  if (!('thinking' in payload)) return payload
  const thinking = payload.thinking
  if (thinking === null || typeof thinking !== 'object') return payload
  if (!('type' in thinking) || thinking.type !== 'enabled') return payload
  return { ...payload, thinking: { type: 'adaptive' } }
}

// Layers the rewrite over an agent's existing `onPayload` (pi-coding-agent
// installs one that dispatches extension `before_provider_request` handlers).
// Honors pi's contract that an `undefined` return means "keep the original
// payload": the inner hook's undefined falls back to the incoming payload
// before the rewrite runs, so the rewrite always sees the effective params.
export function applyAdaptiveThinkingCompat(agent: OnPayloadHost): void {
  const inner = agent.onPayload
  agent.onPayload = async (payload, model) => {
    const effective = inner === undefined ? payload : ((await inner(payload, model)) ?? payload)
    return rewriteThinkingForAdaptiveOnlyModels(effective, model)
  }
}
