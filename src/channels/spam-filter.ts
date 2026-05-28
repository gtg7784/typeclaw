// Inbound content filter for the "single character repeated hundreds of
// times" griefing pattern (e.g. 500x "ㅋ" on one line). Tuned to ignore
// normal "ㅋㅋㅋ" / "lol" / "..." chatter and only flag egregious floods.
// Operates on NFKC-normalised graphemes so "ㅋ" (U+314B compat jamo) and
// "ᄏ" (U+110F initial jamo) collapse to the same code point; precomposed
// syllables ("크크크" U+D06C) are still distinct and caught by run length.

export type SpamCheckResult = { ok: true } | { ok: false; reason: string }

// MIN_LENGTH guards against false positives on short chat (a 6-char "ㅋㅋㅋㅋㅋㅋ"
// is normal). MAX_RUN was picked against the production case — anything over
// a dozen is unusual, 30 leaves headroom for "ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ대박" or "!!!!!!!".
// MIN_LONG_LENGTH gates the more expensive ratio/dominance checks to messages
// long enough that a low unique-char ratio is meaningful signal. Dominance
// bound matches the public DorianAarno/SpamFilter Discord rule (85%) with
// slightly looser cutoff to keep our false-positive rate low.
const MIN_LENGTH = 40
const MAX_RUN = 30
const MIN_LONG_LENGTH = 80
const MIN_UNIQUE_RATIO = 0.05
const MAX_DOMINANCE = 0.9

export function checkSpam(text: string): SpamCheckResult {
  if (text.length < MIN_LENGTH) return { ok: true }

  const graphemes = Array.from(text.normalize('NFKC'))
  if (graphemes.length < MIN_LENGTH) return { ok: true }

  const longestRun = findLongestRun(graphemes)
  if (longestRun >= MAX_RUN) {
    return { ok: false, reason: `repeated-char-run:${longestRun}` }
  }

  if (graphemes.length < MIN_LONG_LENGTH) return { ok: true }

  const counts = countGraphemes(graphemes)
  const uniqueRatio = counts.size / graphemes.length
  if (uniqueRatio < MIN_UNIQUE_RATIO) {
    return { ok: false, reason: `low-unique-ratio:${uniqueRatio.toFixed(3)}` }
  }

  const dominance = maxValue(counts) / graphemes.length
  if (dominance > MAX_DOMINANCE) {
    return { ok: false, reason: `char-dominance:${dominance.toFixed(2)}` }
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

function countGraphemes(graphemes: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const g of graphemes) {
    counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  return counts
}

function maxValue(counts: Map<string, number>): number {
  let max = 0
  for (const v of counts.values()) {
    if (v > max) max = v
  }
  return max
}
