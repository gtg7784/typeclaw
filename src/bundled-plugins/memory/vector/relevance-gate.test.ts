import { describe, expect, it } from 'bun:test'

import { clearsBaseline, gateRelevance, streamAdmissionBaseline } from './relevance-gate'

// Score fixtures reproduced from a live ~193-topic index (multilingual-e5-base
// @q8). E5 compresses unrelated cosines into a ~0.70-0.85 band, so the
// discriminating signal is top1 - baseline(pack), NOT absolute value. NO-MATCH
// queries land top1-baseline <= 0.051; HAS-MATCH queries land >= 0.074. See PR
// description for the full battery.
function band(top: number, baseline: number, n: number): number[] {
  const scores = [top]
  for (let i = 1; i < n; i++) scores.push(baseline + (Math.random() - 0.5) * 0.004)
  return scores.sort((a, b) => b - a)
}

describe('gateRelevance', () => {
  it('suppresses the whole set when top1 barely clears the baseline (no-match)', () => {
    // given: election-query distribution — top 0.8055, baseline ~0.755 (gap 0.051)
    const scores = band(0.8055, 0.755, 193)

    const kept = gateRelevance(scores, 10)

    expect(kept).toBe(0)
  })

  it('keeps a clearly-elevated top (real semantic match)', () => {
    // given: idonghyeop-query distribution — top 0.851, baseline ~0.744 (gap 0.107)
    const scores = band(0.851, 0.744, 193)

    const kept = gateRelevance(scores, 10)

    expect(kept).toBeGreaterThan(0)
  })

  it('caps survivors at topK even when many clear the knee', () => {
    const scores = [0.95, ...Array.from({ length: 50 }, () => 0.9), ...Array.from({ length: 142 }, () => 0.7)]

    const kept = gateRelevance(scores, 10)

    expect(kept).toBeLessThanOrEqual(10)
  })

  it('keeps only the knee — survivors are the elevated head, not the flat pack', () => {
    // given: one sharp winner over a flat pack (idonghyeop shape: 0.851 then ~0.78)
    const scores = [0.851, 0.79, 0.789, ...Array.from({ length: 190 }, () => 0.744)]

    const kept = gateRelevance(scores, 10)

    expect(kept).toBeGreaterThanOrEqual(1)
    expect(kept).toBeLessThan(10)
  })

  it('skips set-level suppression for a tiny corpus (n < 6)', () => {
    // given: 3 shards — too few to estimate a baseline; never suppress to zero
    const scores = [0.78, 0.77, 0.76]

    const kept = gateRelevance(scores, 10)

    expect(kept).toBeGreaterThan(0)
  })

  it('passes ungated when the non-head tail is too short to trust (n=6..9)', () => {
    // given: 9 shards in a flat band — once the top 5 are dropped, only 4 scores
    // remain. A zero-suppression verdict off a 1-4 score median is too noisy, so
    // a flat band that WOULD suppress at n>=10 must instead pass ungated here.
    for (const n of [6, 7, 8, 9]) {
      const scores = [0.792, ...Array.from({ length: n - 1 }, () => 0.78)]

      expect(gateRelevance(scores, 10)).toBeGreaterThan(0)
    }
  })

  it('returns zero for an empty score list', () => {
    expect(gateRelevance([], 10)).toBe(0)
  })

  it('suppresses a flat band once the non-head tail is long enough (n>=10)', () => {
    // given: 10 shards all in a flat ~0.78 band (no real match) — exactly at the
    // gated floor, so the gate now runs and the flat band suppresses to zero.
    const scores = [0.792, ...Array.from({ length: 9 }, () => 0.78)]

    const kept = gateRelevance(scores, 10)

    expect(kept).toBe(0)
  })

  it('is robust to a near-duplicate cluster inflating the mean (real match survives)', () => {
    // given: a clear winner 0.86 plus a dense cluster of near-dupes at ~0.80,
    // then the long flat tail — a raw mean would be inflated by the cluster, but
    // a trimmed/percentile baseline must still let the 0.86 winner through.
    const cluster = Array.from({ length: 15 }, () => 0.8)
    const tail = Array.from({ length: 177 }, () => 0.75)
    const scores = [0.86, ...cluster, ...tail]

    const kept = gateRelevance(scores, 10)

    expect(kept).toBeGreaterThan(0)
  })

  it('suppresses a cross-script-shaped match at the strict default margin', () => {
    // given: a real cross-lingual match whose top1-baseline contrast is compressed
    // to ~0.045 (E5 cross-script gap runs ~half a same-language gap) — below the
    // strict 0.06 margin, so the default gate wrongly suppresses it.
    const scores = band(0.8, 0.755, 193)

    expect(gateRelevance(scores, 10)).toBe(0)
  })

  it('recovers the same cross-script match when the margin is loosened', () => {
    // given: the SAME compressed-contrast distribution, judged with the loosened
    // cross-script margin (~0.04) — the real match now clears the bar.
    const scores = band(0.8, 0.755, 193)

    expect(gateRelevance(scores, 10, 0.04)).toBeGreaterThan(0)
  })

  it('a loosened margin still suppresses a genuine no-match (in-band top1)', () => {
    // given: top1 sits right in the band (gap ~0.01) — even the loosened margin
    // must reject it, so cross-script loosening never becomes "match anything".
    const scores = band(0.765, 0.755, 193)

    expect(gateRelevance(scores, 10, 0.04)).toBe(0)
  })
})

describe('streamAdmissionBaseline + clearsBaseline', () => {
  it('returns null when no topic scores exist (nothing to contrast against)', () => {
    expect(streamAdmissionBaseline([])).toBeNull()
    expect(clearsBaseline(0.99, null)).toBe(false)
  })

  it('tolerates a below-floor topic set (a few topics still give a contrast signal)', () => {
    const baseline = streamAdmissionBaseline([0.5, 0.49])

    expect(baseline).not.toBeNull()
    // a clear stream winner stands above the small topic band
    expect(clearsBaseline(1.0, baseline)).toBe(true)
    // an in-band stream neighbor does not
    expect(clearsBaseline(0.5, baseline)).toBe(false)
  })

  it('returns null for a single topic (one score is not an ambient band)', () => {
    expect(streamAdmissionBaseline([0.9])).toBeNull()
    expect(clearsBaseline(0.99, streamAdmissionBaseline([0.9]))).toBe(false)
  })

  it('excludes a strong top topic from the small-corpus band so fresh streams can still inject (n=2..5)', () => {
    // given: a strong top topic over an ambient band. The old rule kept the head
    // in the pack on n<=5, so a fresh fragment had to beat the BEST topic by the
    // margin and never injected. Trimming top1 contrasts against the band, so a
    // fragment clearing the AMBIENT topics by the margin is admitted.
    const topicScores = [0.9, 0.78, 0.77, 0.76]
    const baseline = streamAdmissionBaseline(topicScores)

    // a fragment well clear of the ambient ~0.77 band injects despite the 0.9 top
    expect(clearsBaseline(0.84, baseline)).toBe(true)
    // an in-band fragment still does not
    expect(clearsBaseline(0.78, baseline)).toBe(false)
  })

  it('admits a stream row only when it clears the topic band by the margin', () => {
    const baseline = streamAdmissionBaseline(Array.from({ length: 30 }, () => 0.78))

    expect(clearsBaseline(0.781, baseline)).toBe(false)
    expect(clearsBaseline(0.78 + 0.06, baseline)).toBe(true)
  })
})
