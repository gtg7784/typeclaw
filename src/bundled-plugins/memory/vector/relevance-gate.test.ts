import { describe, expect, it } from 'bun:test'

import { gateRelevance } from './relevance-gate'

// Score fixtures reproduced from the live typeeybot index (193 topics,
// multilingual-e5-base@q8). E5 compresses unrelated cosines into a ~0.70-0.85
// band, so the discriminating signal is top1 - baseline(pack), NOT absolute
// value. NO-MATCH queries land top1-baseline <= 0.051; HAS-MATCH queries land
// >= 0.074. See PR description for the full battery.
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

  it('returns zero for an empty score list', () => {
    expect(gateRelevance([], 10)).toBe(0)
  })

  it('uses a median baseline for a mid-size corpus (6 <= n < 20) and still suppresses a flat band', () => {
    // given: 10 shards all in a flat ~0.78 band (no real match)
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
})
