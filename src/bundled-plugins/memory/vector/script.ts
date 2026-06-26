// Script-class detection for cross-lingual relevance gating.
//
// E5's cosine contrast (top1 - baseline) is calibrated, in the gate, on a
// SAME-script distribution: a live English index measured no-match <= 0.051 and
// has-match >= 0.074, so MARGIN=0.06 separates them. A CROSS-script query (the
// user writes Korean, the matching memory was logged in English, or vice versa)
// embeds into the same multilingual space but with a STRUCTURALLY LOWER contrast
// — the cross-lingual pair sits closer to the ambient band, so a genuine match's
// top1-baseline gap shrinks below 0.06 and the gate wrongly suppresses the whole
// vector lane. The keyword lane can't rescue it either: a pure non-Latin query
// shares no tokens with a Latin corpus.
//
// The fix is language-agnostic and symmetric: detect the query's dominant script
// and the candidate band's scripts; when they DON'T overlap, scale the margin
// down so the lower-but-real cross-script contrast can still clear it. Same-script
// pairs keep the full strict margin, so the no-match suppression guarantee — and
// the per-turn memory-bleed protection that rides on it — is untouched for the
// common case. This is deliberately script-class granularity (not full language
// id): the highest-compression pairs are non-Latin<->Latin (KO/JA/ZH/RU/AR vs
// EN), which script ranges separate cheaply with no model on the hot path. Latin
// <->Latin pairs (EN<->ES<->FR) are left strict; E5 keeps Latin-script languages
// closer, so their contrast is less compressed and least needs loosening.

export type ScriptClass = 'latin' | 'cjk' | 'cyrillic' | 'arabic' | 'other'

// CJK = Hiragana, Katakana, CJK Ext-A, CJK Unified, CJK Compat, Hangul,
// half-width Kana. Mirrors the proven range set in truncation.ts (the embedder's
// CJK token estimate), so "what counts as CJK" stays consistent across the
// vector subsystem.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]/u
const CYRILLIC = /[\u0400-\u04ff\u0500-\u052f]/u
const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u
const LATIN = /[a-z\u00c0-\u024f]/iu

// A plain per-character majority mis-ranks mixed text: one Hangul syllable
// encodes the phonemes of several Latin letters, so Latin letters out-count
// Hangul chars in text that reads as plainly Korean (`Discord 봇 분류 peer bot`).
// A non-Latin script therefore wins on a SHARE threshold, not a raw majority —
// substantial non-Latin presence is the cross-script signal the gate needs even
// when Latin keyword anchors are present.
const NON_LATIN_DOMINANCE_SHARE = 0.2

export function dominantScript(text: string): ScriptClass {
  const counts: Record<ScriptClass, number> = { latin: 0, cjk: 0, cyrillic: 0, arabic: 0, other: 0 }
  for (const char of text) {
    if (CJK.test(char)) counts.cjk++
    else if (CYRILLIC.test(char)) counts.cyrillic++
    else if (ARABIC.test(char)) counts.arabic++
    else if (LATIN.test(char)) counts.latin++
    else if (/\p{L}/u.test(char)) counts.other++
  }

  const scriptBearing = counts.latin + counts.cjk + counts.cyrillic + counts.arabic + counts.other
  if (scriptBearing === 0) return 'latin'

  let winner: ScriptClass = 'latin'
  let max = 0
  for (const script of ['cjk', 'cyrillic', 'arabic', 'other'] as const) {
    if (counts[script] > max && counts[script] / scriptBearing >= NON_LATIN_DOMINANCE_SHARE) {
      max = counts[script]
      winner = script
    }
  }
  if (winner !== 'latin') return winner
  return counts.latin > 0 || max === 0 ? 'latin' : winner
}

// How much E5's cross-script contrast typically shrinks vs a same-script pair.
// Cross-lingual top1-baseline gaps run roughly half a same-language gap on the
// live index, so a same-script 0.06 margin maps to ~0.04 cross-script — enough
// to admit a real cross-lingual match while still rejecting the in-band no-match
// floor. Conservative on purpose: it loosens, it does not disable the gate.
const CROSS_SCRIPT_MARGIN_SCALE = 0.04 / 0.06

// Returns a multiplier for the gate's MARGIN. 1 = strict (unchanged). A value
// below 1 loosens the gate for a cross-script query. The band is "same-script"
// (no loosening) when the query's script appears among the candidates at all —
// those same-script candidates already give the query a valid contrast, so the
// gate needs no help. Only when the query's script is ENTIRELY absent from the
// candidate band is this a genuine cross-script retrieval that the strict margin
// over-suppresses. An empty band returns 1: with nothing to compare against we
// can't establish a mismatch, so stay strict.
export function crossScriptMarginScale(queryScript: ScriptClass, candidateScripts: ScriptClass[]): number {
  if (candidateScripts.length === 0) return 1
  if (candidateScripts.includes(queryScript)) return 1
  return CROSS_SCRIPT_MARGIN_SCALE
}
