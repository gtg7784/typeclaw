import { stripCitationLines } from './citations'
import { slugIsHeadingEcho } from './slug'

// Channel injection shows the agent only the heading, assuming the heading IS the
// shard's self-contained belief sentence. Legacy/dreaming shards put a noun-phrase
// TITLE there and the belief sentence in the body, so channel turns see a bare
// title carrying no fact. These helpers recover the belief sentence so a channel
// render can surface it — bounded to ONE sentence, never the full body, so the
// memory-bleed posture is unchanged. Script-agnostic by design (agents run in
// Korean/CJK/Arabic): no ASCII `\b`, no English stopword/verb heuristics.

const REFERENCES_HEADING = /^[\s-]*references\s*:\s*$/i

// Sentence terminators across the scripts agents run in: Latin `.!?`, CJK/fullwidth
// `。！？`, Arabic question mark `؟`, and Devanagari danda `।`. `\.` is only treated
// as a terminator when followed by whitespace or end-of-string, so a decimal like
// `3.5` or `v1.2` inside the belief does not cut the sentence short.
const SENTENCE_END = /[。！？؟।!?]|\.(?=\s|$)/u

// The first sentence of `line`: text up to and including the first terminator. A
// line with no terminator (a title/label) is itself one sentence and returned whole.
function firstSentenceOf(line: string): string {
  const match = SENTENCE_END.exec(line)
  if (match === null) return line
  return line.slice(0, match.index + match[0].length).trim()
}

export function firstBeliefSentence(body: string): string | undefined {
  const prose = stripCitationLines(body)
  for (const raw of prose.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (REFERENCES_HEADING.test(line)) continue
    const unwrapped = line.replace(/^#{1,6}\s+/, '').trim()
    if (unwrapped !== '') return firstSentenceOf(unwrapped)
  }
  return undefined
}

// A heading is "title-like" (a noun-phrase label) rather than a self-contained
// belief sentence. The cheap, language-agnostic signal: a heading that is a clean
// kebab echo of its own slug ("T1 Competition Status 2026" -> `t1-competition-
// status-2026`) is a title, because a real belief sentence (with a predicate and
// scope) does not survive slugification as a clean echo — it is too long and
// carries punctuation/particles that `headingToSlug` collapses. `slugIsHeadingEcho`
// already returns false for all-CJK/emoji headings (normalization discarded
// content), so a Korean belief sentence is never misread as a title by this path.
export function isTitleLikeHeading(heading: string, slug: string): boolean {
  return slugIsHeadingEcho(heading, slug)
}
