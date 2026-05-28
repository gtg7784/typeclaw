export type OutboundFloodCheckResult = { ok: true } | { ok: false; reason: string }

const MIN_LENGTH = 40
const MAX_RUN = 30
const MIN_LONG_LENGTH = 80
const MIN_UNIQUE_RATIO = 0.05
const MAX_DOMINANCE = 0.9

export function checkOutboundFlood(text: string): OutboundFloodCheckResult {
  if (text.length < MIN_LENGTH) return { ok: true }

  const graphemes = Array.from(text.normalize('NFKC'))
  if (graphemes.length < MIN_LENGTH) return { ok: true }

  const longestRun = findLongestRun(graphemes)
  if (longestRun >= MAX_RUN) return { ok: false, reason: `repeated-char-run:${longestRun}` }

  if (graphemes.length < MIN_LONG_LENGTH) return { ok: true }

  const counts = countGraphemes(graphemes)
  const uniqueRatio = counts.size / graphemes.length
  if (uniqueRatio < MIN_UNIQUE_RATIO) return { ok: false, reason: `low-unique-ratio:${uniqueRatio.toFixed(3)}` }

  const dominance = maxValue(counts) / graphemes.length
  if (dominance > MAX_DOMINANCE) return { ok: false, reason: `char-dominance:${dominance.toFixed(2)}` }

  return { ok: true }
}

function findLongestRun(graphemes: readonly string[]): number {
  if (graphemes.length === 0) return 0
  let longest = 1
  let current = 1
  for (let i = 1; i < graphemes.length; i++) {
    if (graphemes[i] === graphemes[i - 1]) {
      current++
      if (current > longest) longest = current
    } else {
      current = 1
    }
  }
  return longest
}

function countGraphemes(graphemes: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const grapheme of graphemes) counts.set(grapheme, (counts.get(grapheme) ?? 0) + 1)
  return counts
}

function maxValue(counts: Map<string, number>): number {
  let max = 0
  for (const value of counts.values()) {
    if (value > max) max = value
  }
  return max
}
