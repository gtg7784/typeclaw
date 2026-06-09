// A channel turn ends after a successful `channel_reply` (the terminal-reply
// abort in router.ts). When the model's reply PROMISES to keep working this
// turn ("바로 확인해볼게요", "let me check", "I'll continue now") but it forgot
// to set `channel_reply({ continue: true })`, the turn aborts and the promised
// follow-up never runs. The router uses this detector to inject ONE bounded
// reminder nudge so the model gets a second chance. See the empty-turn retry
// (router.ts) for the sibling mechanism this mirrors.
//
// Design bias: PREFER FALSE NEGATIVES. A miss leaves the status quo (turn ends,
// recoverable by a later user message); a false positive costs one wasted
// reminder-only turn that the model ends with NO_REPLY. So the phrase tables are
// deliberately narrow — only self-directed FUTURE intent to act THIS turn, never
// descriptive ("I checked and it's fine") or other-directed ("you can continue")
// usage. This is a HINT, not a control-flow authority: the abort still fires
// regardless; only the optional nudge is gated on it.

// Strip markdown emphasis/code fences before matching so an inline `gh` span
// inside "바로 `gh`로 확인할게요" does not split the phrase.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Self-directed future-intent phrases. Each asserts the SPEAKER will do more
// work imminently. The leading "i" / "let me" anchors self-direction so
// "you can continue" never matches.
const EN_PHRASES: readonly string[] = [
  "i'll continue",
  'i will continue',
  "i'll keep going",
  "i'll keep checking",
  "i'll keep looking",
  "i'll take a look",
  "i'll check",
  "i'll look into",
  "i'll dig in",
  "i'll go ahead and",
  'let me check',
  'let me look',
  'let me take a look',
  'let me dig',
  'let me continue',
  'let me verify',
  'checking now',
  'looking into it now',
  'working on it now',
  'on it now',
  'give me a moment',
  'give me a sec',
]

// Korean: -ㄹ게요 / -겠습니다 future-volitional endings on check/look/continue/
// proceed verbs. These endings are first-person volitional in Korean — they
// cannot address the listener, so they are safe self-direction anchors that
// descriptive or other-directed sentences do not produce. Bare "계속" is
// excluded ("계속 진행하세요" = "you go ahead", terminal).
const KO_PHRASES: readonly string[] = [
  '확인해볼게요',
  '확인해 볼게요',
  '확인할게요',
  '확인하겠습니다',
  '확인해보겠습니다',
  '확인해 보겠습니다',
  '다시 확인하겠습니다',
  '다시 확인해보겠습니다',
  '이어서 확인',
  '계속 확인',
  '계속 진행할게요',
  '계속 진행하겠습니다',
  '계속하겠습니다',
  '계속할게요',
  '바로 확인',
  '바로 볼게요',
  '바로 진행',
  '살펴볼게요',
  '살펴보겠습니다',
  '진행하겠습니다',
  '잠시만요',
  '잠깐만요',
  '곧 알려',
]

const ALL_PHRASES: readonly string[] = [...EN_PHRASES, ...KO_PHRASES]

// Reply texts shorter than this are almost always a complete final answer
// ("네", "ok", "done") where a partial match would be noise. The shortest
// legitimate intent phrases ("on it now", "확인할게요") clear this floor.
const MIN_LENGTH = 4

export function detectContinuationWillingness(text: string): boolean {
  if (text.length < MIN_LENGTH) return false
  const normalized = normalize(text)
  if (normalized.length < MIN_LENGTH) return false
  return ALL_PHRASES.some((phrase) => normalized.includes(phrase))
}
