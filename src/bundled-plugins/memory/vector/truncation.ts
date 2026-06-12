// Xenova/multilingual-e5-base is a 512-token model; transformers.js truncates
// past that limit by default. Inputs longer than the cap would otherwise lose
// their tail from the embedded match surface SILENTLY. Canonical compact shards
// (heading + one belief sentence first) sit well under the cap; legacy verbose
// shards, legacy prose migration events, long fragments, and very long queries
// can exceed it. This module estimates token length cheaply (no tokenizer) and
// bounds the embeddable text deterministically so the cut is explicit, not a
// hidden tokenizer side effect. The dreaming subagent separately compacts the
// flagged shards over time, but bounding here guarantees no silent loss even
// for inputs dreaming never rewrites (e.g. raw legacy prose).
export const MAX_MODEL_TOKENS = 512

// The E5 prefix ("query: " / "passage: ") is prepended before tokenization and
// eats a couple of tokens from the budget. Subtracting a small reserve keeps
// the bound honest about the text budget the caller actually gets.
const PREFIX_TOKEN_RESERVE = 4

// Char-per-token ratio for a rough, deliberately CONSERVATIVE token estimate.
// multilingual-e5-base tokenizes CJK and other non-Latin scripts into far more
// tokens per character than English, so a single chars/token ratio would badly
// under-count them. We estimate per script: ~3.5 chars/token for Latin-ish
// text, ~1 token per CJK character. Over-estimating (bounding a little early) is
// safer than under-estimating (letting the tokenizer cut silently), so the
// ratios lean toward flagging.
//
// The char ratio ALONE under-counts many short words: WordPiece emits at least
// one token per whitespace-delimited word, so `'a '.repeat(509)` is ~509 tokens
// but only ~291 by chars/3.5. The non-CJK estimate therefore takes the MAX of
// the char-ratio count and the word count, and the inverse (charBudgetForTokens)
// charges a token at each word start too, so a bounded string re-estimates to at
// most the budget under either term.
const LATIN_CHARS_PER_TOKEN = 3.5

// Effective text-token budget once the prefix reserve is removed.
export const TEXT_TOKEN_BUDGET = MAX_MODEL_TOKENS - PREFIX_TOKEN_RESERVE

// CJK Unified Ideographs, Hiragana, Katakana, Hangul — scripts the tokenizer
// splits at roughly one token per character (often more). Counted 1:1.
// The `g` variant is for counting matches across a whole string (estimateTokens);
// the non-global variant is for per-character tests (charBudgetForTokens), where
// a global regex's stateful lastIndex would make repeated `.test()` calls flip.
const CJK_COUNT_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]/gu
const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]/u

// A conservative token-count estimate that never loads the tokenizer (which
// would defeat the embedder's deliberate lazy-load of the heavy native stack).
// CJK chars count 1 token each; the remaining (non-CJK) text counts the MAX of
// its char-ratio estimate and its word count, because WordPiece never emits
// fewer than one token per whitespace-delimited word.
export function estimateTokens(text: string): number {
  const cjkCount = (text.match(CJK_COUNT_PATTERN) ?? []).length
  const nonCjkChars = text.length - cjkCount
  const charBased = Math.ceil(nonCjkChars / LATIN_CHARS_PER_TOKEN)
  return cjkCount + Math.max(charBased, countNonCjkWords(text))
}

// Count whitespace-delimited words AFTER removing CJK chars (those are already
// charged one token each), so a CJK run isn't double-counted as an extra word.
function countNonCjkWords(text: string): number {
  return (text.replace(CJK_COUNT_PATTERN, ' ').match(/\S+/gu) ?? []).length
}

export function isOverBudget(text: string): boolean {
  return estimateTokens(text) > TEXT_TOKEN_BUDGET
}

// Topic passages go through `topicPassage` in passages.ts (it strips citation
// lines from the embedded text); over-budget detection for topics derives from
// that same helper so the budget check matches what is actually embedded. This
// helper covers stream fragments, whose embedded text is `topic\nbody`.
export function fragmentEmbeddableText(event: { topic: string; body: string }): string {
  return `${event.topic}\n${event.body}`
}

export type BoundedText = {
  text: string
  bounded: boolean
  estimatedTokens: number
}

// Deterministically trim text to the estimated token budget BEFORE embedding, so
// the tokenizer's implicit cut never fires and the truncation point is one we
// own and can record. Bounds on a character budget derived from the same
// conservative estimate; the leading heading/belief sentence (the load-bearing
// retrieval signal) always survives because it comes first.
export function boundEmbeddableText(text: string): BoundedText {
  const estimatedTokens = estimateTokens(text)
  if (estimatedTokens <= TEXT_TOKEN_BUDGET) {
    return { text, bounded: false, estimatedTokens }
  }
  const charBudget = charBudgetForTokens(text, TEXT_TOKEN_BUDGET)
  return { text: text.slice(0, charBudget), bounded: true, estimatedTokens }
}

// Returns the longest prefix length (in chars) whose estimateTokens is still
// within budget. Recomputes the EXACT same estimate incrementally — CJK chars
// at 1 token, plus max(non-CJK char-ratio, word count) — so a bounded prefix can
// never re-estimate above the budget no matter which term dominates. estimate is
// monotonic non-decreasing in prefix length, so a single forward walk suffices.
function charBudgetForTokens(text: string, tokenBudget: number): number {
  let cjk = 0
  let nonCjk = 0
  let words = 0
  let inWord = false
  let chars = 0
  for (const char of text) {
    const isCjk = CJK_CHAR_PATTERN.test(char)
    const isSpace = /\s/u.test(char)
    // A word start is a non-space, non-CJK char that follows a non-word char.
    // CJK chars are charged via `cjk`, never as words (mirrors countNonCjkWords).
    const startsWord = !isSpace && !isCjk && !inWord
    const nextCjk = isCjk ? cjk + 1 : cjk
    const nextNonCjk = isCjk ? nonCjk : nonCjk + char.length
    const nextWords = startsWord ? words + 1 : words
    const estimate = nextCjk + Math.max(Math.ceil(nextNonCjk / LATIN_CHARS_PER_TOKEN), nextWords)
    if (estimate > tokenBudget) break
    cjk = nextCjk
    nonCjk = nextNonCjk
    words = nextWords
    inWord = !isSpace && !isCjk
    chars += char.length
  }
  return chars
}
