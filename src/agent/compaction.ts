import type { KnownApi, Model } from '@mariozechner/pi-ai'
import { SettingsManager } from '@mariozechner/pi-coding-agent'

// Compaction trigger threshold expressed as a percentage of the model's
// context window. pi-coding-agent's auto-compaction fires when
// `contextTokens > contextWindow - reserveTokens`. To honor a percentage-
// based intent across models with very different window sizes (200K Claude
// vs. 1M Gemini vs. 256K Kimi), we derive `reserveTokens` per-model from
// the model's `contextWindow`. SDK defaults (16384 reserve) are a fixed
// number of tokens that drift in relative terms across models — at 256K
// that's ~6% headroom (94% trigger), at 1M it's ~1.6% (98% trigger). A
// percentage-derived reserve trips at the same fraction regardless of
// model, which is what we actually want.
export const COMPACTION_TRIGGER_PERCENT = 0.8

// Tokens to keep in the recent window after compaction. Fixed (not a
// percentage) because "recent context" is a property of conversation
// shape, not model capacity — the same recent ~20K is roughly the right
// amount of history regardless of whether the model has 200K or 1M total.
// Mirrors pi's DEFAULT_COMPACTION_SETTINGS.keepRecentTokens.
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000

export function reserveTokensForModel<TApi extends KnownApi>(model: Model<TApi>): number {
  return Math.max(1, Math.round(model.contextWindow * (1 - COMPACTION_TRIGGER_PERCENT)))
}

export function createCompactionSettingsManager<TApi extends KnownApi>(model: Model<TApi>): SettingsManager {
  return SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: reserveTokensForModel(model),
      keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
    },
  })
}
