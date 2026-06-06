export type OutboundFloodCheckResult = { ok: true } | { ok: false; reason: string }

const MIN_LENGTH = 40
const MAX_RUN = 30
const MIN_LONG_LENGTH = 80
const MAX_DOMINANCE = 0.9

// Contiguous-span detector for multi-character floods ("lollol...", "ababab...",
// repeated emoji pairs) — including a flood body buried inside otherwise-varied
// text, which a whole-message periodicity test misses. Strict equality (no
// mismatch budget) and a large span floor keep it clear of incidental prose
// repetition ("---", "....", "hahaha", code indentation, table separators).
const MAX_REPEATING_PERIOD = 32
// Span floor is deliberately a flood boundary, not a "never-deny" guarantee: it
// catches obvious short-period floods like "ab".repeat(300) (600 chars) and
// "lol".repeat(300) (900). Hundreds of byte-identical rows or box-art lines also
// trip it — that output is information-poor and flood-like, and raising the floor
// to clear it would let those real floods through. Tables/diagrams with varying
// cells break periodicity and pass.
const MIN_PERIODIC_SPAN = 384
const MIN_PERIODIC_REPETITIONS = 24

// Narrow last resort: structured text (code, tables, logs) is often lower-
// entropy than prose, so this only fires on a tiny alphabet at real length.
const MIN_ENTROPY_LENGTH = 200
const MAX_TINY_ALPHABET_SIZE = 4
const VERY_LOW_ENTROPY_BITS = 1.25

// Replaces the old `uniqueRatio = distinctChars / length` gate, which was
// length-coupled: natural language draws from a fixed alphabet, so any reply
// past ~(alphabet/0.05) chars failed it regardless of variety — a 2.9KB
// markdown report was silently dropped. Every check below is bounded-run or
// length-independent, so length alone never makes a reply look like a flood.
export function checkOutboundFlood(text: string): OutboundFloodCheckResult {
  if (text.length < MIN_LENGTH) return { ok: true }

  const graphemes = Array.from(text.normalize('NFKC'))
  if (graphemes.length < MIN_LENGTH) return { ok: true }

  const longestRun = findLongestRun(graphemes)
  if (longestRun >= MAX_RUN) return { ok: false, reason: `repeated-char-run:${longestRun}` }

  if (graphemes.length < MIN_LONG_LENGTH) return { ok: true }

  const counts = countGraphemes(graphemes)

  const dominance = maxValue(counts) / graphemes.length
  if (dominance > MAX_DOMINANCE) return { ok: false, reason: `char-dominance:${dominance.toFixed(2)}` }

  const span = findLongestPeriodicSpan(graphemes)
  if (span !== undefined) return { ok: false, reason: `repeated-pattern-span:${span.period}:${span.spanLength}` }

  if (graphemes.length >= MIN_ENTROPY_LENGTH && counts.size <= MAX_TINY_ALPHABET_SIZE) {
    const entropy = shannonEntropyBitsPerGrapheme(counts, graphemes.length)
    if (entropy < VERY_LOW_ENTROPY_BITS) return { ok: false, reason: `low-entropy:${entropy.toFixed(2)}` }
  }

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

// Longest contiguous span (in graphemes) that is exactly periodic at some
// period 2..32, or undefined when no span clears the flood floor. Period 1 is
// left to the run check above. A span must reach MIN_PERIODIC_SPAN graphemes
// AND repeat its unit MIN_PERIODIC_REPETITIONS times — the larger bound wins,
// so a 32-period unit needs 768 graphemes, not three echoes of a 32-char line.
function findLongestPeriodicSpan(graphemes: readonly string[]): { period: number; spanLength: number } | undefined {
  const maxPeriod = Math.min(MAX_REPEATING_PERIOD, Math.floor(graphemes.length / MIN_PERIODIC_REPETITIONS))
  let best: { period: number; spanLength: number } | undefined
  for (let period = 2; period <= maxPeriod; period++) {
    let matches = 0
    let longestForPeriod = 0
    for (let i = period; i < graphemes.length; i++) {
      if (graphemes[i] === graphemes[i - period]) {
        matches++
        const spanLength = matches + period
        if (spanLength > longestForPeriod) longestForPeriod = spanLength
      } else {
        matches = 0
      }
    }
    const requiredSpan = Math.max(MIN_PERIODIC_SPAN, period * MIN_PERIODIC_REPETITIONS)
    if (longestForPeriod < requiredSpan) continue
    if (best === undefined || longestForPeriod > best.spanLength) best = { period, spanLength: longestForPeriod }
  }
  return best
}

function shannonEntropyBitsPerGrapheme(counts: Map<string, number>, length: number): number {
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
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
