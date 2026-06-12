// E5 embeddings (multilingual-e5-base) compress cosine similarity into a narrow
// ~0.70-0.85 band even for unrelated pairs — a documented consequence of the
// low InfoNCE training temperature (tau=0.01). Absolute thresholds therefore
// cannot tell a real match from baseline noise: an unrelated query's top hit
// (0.8055) can outscore a genuine match's top hit (0.7786) on a different query.
//
// The discriminating signal is QUERY-LOCAL CONTRAST: how far the best score
// stands above this query's own baseline cluster. A real match lifts top1 well
// clear of the pack; a no-match leaves top1 buried in the band. Measured on a
// live 193-topic index, no-match queries land top1-baseline <= 0.051 and
// has-match queries land >= 0.074, so a 0.06 margin separates them cleanly.
//
// The baseline is the MEDIAN of the non-head scores (robust to a near-duplicate
// cluster inflating a raw mean), which keeps a genuine winner above a crowd of
// similar topics. Below SMALL_CORPUS_FLOOR there are too few scores to estimate
// a baseline, so suppression is skipped — a false negative (injecting one
// obvious shard) is cheaper than wrongly suppressing the only relevant memory.
const MARGIN = 0.06
const SMALL_CORPUS_FLOOR = 6
const HEAD_EXCLUDED_FROM_BASELINE = 5

// Returns how many of the sorted-descending cosine scores survive the gate.
// Zero means "no relevant memory matched" — a valid, expected outcome the
// caller injects as an empty memory block. `scores` MUST be sorted descending.
export function gateRelevance(scores: number[], topK: number): number {
  if (scores.length === 0 || topK <= 0) return 0
  if (scores.length < SMALL_CORPUS_FLOOR) return Math.min(scores.length, topK)

  const top = scores[0]!
  const baseline = median(scores.slice(HEAD_EXCLUDED_FROM_BASELINE))
  const margin = top - baseline
  if (margin < MARGIN) return 0

  const knee = top - 0.5 * margin
  const survivors = scores.filter((score) => score >= knee).length
  return Math.min(survivors, topK)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}
