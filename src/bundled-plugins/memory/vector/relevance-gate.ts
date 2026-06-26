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
// similar topics. Suppression only fires once the non-head pack is large enough
// to estimate the band: the top HEAD_EXCLUDED_FROM_BASELINE scores are dropped,
// and at least MIN_BASELINE_PACK must remain. Below that, suppression is skipped
// — a false negative (injecting one obvious shard) is cheaper than wrongly
// suppressing the only relevant memory off a noisy 1-4 score tail.
//
// The contrast is top1 - median(non-head). A UNIFORM upward shift of the whole
// band (the "single-domain memory, everything is somewhat related" case) cancels
// out of that difference and leaves the verdict unchanged, so a concentrated
// corpus does NOT structurally compress the gap. Only a genuine reduction in
// rank SPREAD would, and a spread-normalized gate (gap >= k*MAD, or a z-score)
// is rejected on purpose: a no-match query can also produce a tight non-head
// pack plus one order-statistic outlier, which is exactly the case the absolute
// MARGIN suppresses. We keep the absolute margin as the vector-only no-match
// guard; recovery for a genuinely-suppressed single-domain match belongs in the
// corroborating keyword lane, not in a weaker semantic threshold.
// The same-script default. A cross-script query (detected in hybrid.ts via
// script.ts) passes a SMALLER margin here, because E5's cross-lingual top1-
// baseline contrast is structurally compressed below this same-language bar.
// The parameter defaults to MARGIN, so every same-script call is unchanged.
export const MARGIN = 0.06
const HEAD_EXCLUDED_FROM_BASELINE = 5
// Minimum non-head scores required to trust a suppression verdict. A median over
// 1-4 scores (n=6..9 once the head is dropped) is too noisy to zero out the only
// memory on, so the gated path needs HEAD_EXCLUDED_FROM_BASELINE + this many.
const MIN_BASELINE_PACK = 5
const GATED_TOPIC_FLOOR = HEAD_EXCLUDED_FROM_BASELINE + MIN_BASELINE_PACK

// The contrast reference for ADMITTING stream rows: the median of the available
// topic scores with the head trimmed. Topics define the ambient cosine band;
// sparse streams consume it but never define it, so a nearest-neighbour cluster
// of fragments can't move the bar. Returns null when fewer than two topic scores
// exist — one score is not an ambient band, so an uncorroborated semantic-only
// stream must not inject off it (it can still reach RRF via the keyword lane).
//
// The head trim is ADAPTIVE because streams never pass ungated: a strong top
// topic must NOT raise the stream bar, or a genuinely-fresh fragment would have
// to beat your best existing topic by the full margin and so never inject on a
// small corpus. So we always drop at least top1, scaling the exclusion up to
// HEAD_EXCLUDED_FROM_BASELINE only while a MIN_BASELINE_PACK-size tail survives.
//   n=2..5  → drop top1, contrast against the remaining ambient topics
//   n=6..9  → drop enough head to keep a MIN_BASELINE_PACK tail
//   n>=10   → drop the full top HEAD_EXCLUDED_FROM_BASELINE
// `topicScores` MUST be sorted descending.
export function streamAdmissionBaseline(topicScores: number[]): number | null {
  if (topicScores.length <= 1) return null
  const excluded = Math.min(HEAD_EXCLUDED_FROM_BASELINE, Math.max(1, topicScores.length - MIN_BASELINE_PACK))
  return median(topicScores.slice(excluded))
}

// Whether a single cosine score clears the band by the shared margin. Used to
// admit stream rows against the topic contrast reference: a stream candidate
// survives only if it stands as far above the band as a real topic match would.
// A null baseline (no topics at all) admits nothing.
export function clearsBaseline(score: number, baseline: number | null, margin: number = MARGIN): boolean {
  return baseline !== null && score - baseline >= margin
}

// Returns how many of the sorted-descending topic cosine scores survive the
// gate. Zero means "no relevant memory matched" — a valid, expected outcome the
// caller injects as an empty memory block. Below GATED_TOPIC_FLOOR the non-head
// tail is too short (1-4 scores) for a reliable suppression verdict, so topics
// pass ungated (a false negative of one obvious shard is cheaper than
// suppressing the only memory). `scores` MUST be sorted descending.
export function gateRelevance(scores: number[], topK: number, margin: number = MARGIN): number {
  if (scores.length === 0 || topK <= 0) return 0
  if (scores.length < GATED_TOPIC_FLOOR) return Math.min(scores.length, topK)

  const top = scores[0]!
  const contrast = top - median(scores.slice(HEAD_EXCLUDED_FROM_BASELINE))
  if (contrast < margin) return 0

  const knee = top - 0.5 * contrast
  const survivors = scores.filter((score) => score >= knee).length
  return Math.min(survivors, topK)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}
