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

// The contrast reference for ADMITTING stream rows: the median of the available
// topic scores (head excluded once there are enough to trim). Topics define the
// ambient cosine band; sparse streams consume it but never define it, so a
// nearest-neighbour cluster of fragments can't move the bar. Returns null only
// when NO topic scores exist — with nothing to contrast against, an
// uncorroborated semantic-only stream must not inject (it can still reach RRF
// via the keyword lane). Unlike topic suppression, this tolerates a below-floor
// topic set: even a few topics give a usable "is this stream clearly elevated?"
// signal, which is exactly the contrast a vector-only fragment match needs.
// `topicScores` MUST be sorted descending.
export function streamAdmissionBaseline(topicScores: number[]): number | null {
  if (topicScores.length === 0) return null
  const pack =
    topicScores.length > HEAD_EXCLUDED_FROM_BASELINE ? topicScores.slice(HEAD_EXCLUDED_FROM_BASELINE) : topicScores
  return median(pack)
}

// Whether a single cosine score clears the band by the shared margin. Used to
// admit stream rows against the topic contrast reference: a stream candidate
// survives only if it stands as far above the band as a real topic match would.
// A null baseline (no topics at all) admits nothing.
export function clearsBaseline(score: number, baseline: number | null): boolean {
  return baseline !== null && score - baseline >= MARGIN
}

// Returns how many of the sorted-descending topic cosine scores survive the
// gate. Zero means "no relevant memory matched" — a valid, expected outcome the
// caller injects as an empty memory block. Below SMALL_CORPUS_FLOOR there are
// too few topics for a reliable suppression verdict, so topics pass ungated (a
// false negative of one obvious shard is cheaper than suppressing the only
// memory). `scores` MUST be sorted descending.
export function gateRelevance(scores: number[], topK: number): number {
  if (scores.length === 0 || topK <= 0) return 0
  if (scores.length < SMALL_CORPUS_FLOOR) return Math.min(scores.length, topK)

  const top = scores[0]!
  const margin = top - median(scores.slice(HEAD_EXCLUDED_FROM_BASELINE))
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
