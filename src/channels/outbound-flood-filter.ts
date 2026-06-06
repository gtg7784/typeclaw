export type OutboundFloodCheckResult = { ok: true } | { ok: false; reason: string }

const MIN_LENGTH = 40
const MAX_RUN = 30
const MIN_LONG_LENGTH = 80
const MAX_DOMINANCE = 0.9

// Period-based detector for floods that aren't a single repeated grapheme
// ("lollol...", "ababab...", repeated emoji pairs). Bounded period keeps it
// O(n * period) and below the short-range repetition of real prose; the small
// mismatch budget tolerates a stray edit without passing varied text.
const MAX_REPEATING_PERIOD = 32
const MAX_PERIOD_MISMATCH_RATIO = 0.02

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

  const period = findRepeatingPeriod(graphemes)
  if (period !== undefined) return { ok: false, reason: `repeated-pattern-period:${period}` }

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

// Smallest period the whole message repeats on within the mismatch budget, or
// undefined. Capped at length/4 so a pattern must repeat 4+ times to count.
function findRepeatingPeriod(graphemes: readonly string[]): number | undefined {
  const maxPeriod = Math.min(MAX_REPEATING_PERIOD, Math.floor(graphemes.length / 4))
  for (let period = 1; period <= maxPeriod; period++) {
    const compared = graphemes.length - period
    const allowedMismatches = Math.floor(compared * MAX_PERIOD_MISMATCH_RATIO)
    let mismatches = 0
    let exceeded = false
    for (let i = period; i < graphemes.length; i++) {
      if (graphemes[i] !== graphemes[i - period]) {
        mismatches++
        if (mismatches > allowedMismatches) {
          exceeded = true
          break
        }
      }
    }
    if (!exceeded) return period
  }
  return undefined
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
