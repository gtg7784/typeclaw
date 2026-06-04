// Deterministic phrase classifier for the false-receipt guard (channel-reply.ts):
// how strongly does a github PR reply CLAIM a formal verdict/close-out it may not
// have actually performed? The taxonomy errs toward WARN over BLOCK on purpose —
// a false block breaks a legitimate reply; a missed soft-fake only loses a nudge.

export type ReviewClaim = 'block-approve' | 'block-request-changes' | 'block-resolve' | 'warn' | 'ignore'

// Word-boundary anchored so "approved" never fires inside "unapproved".
const BLOCK_APPROVE: readonly RegExp[] = [
  /\bapproved\b/,
  /\bapproving\b/,
  /\bi approve\b/,
  /\bapproval (submitted|sent|posted)\b/,
  /\bsubmitting (the )?approval\b/,
  /\bformal approval\b/,
  /\blgtm,? approved\b/,
]

const BLOCK_REQUEST_CHANGES: readonly RegExp[] = [
  /\brequest(ing|ed)? changes\b/,
  /\bchanges requested\b/,
  /\bi request changes\b/,
  /\bblocking (this|the|merge)\b/,
  /\bthis is blocked\b/,
]

// Only consulted by the caller when thread!=null (a review thread). Bare
// "resolved" is intentionally NOT here — it collides with the warn-tier "looks
// resolved?"; resolve claims must carry a definite marker (marked/that/this/
// thanks) or a verify clause.
const BLOCK_RESOLVE: readonly RegExp[] = [
  /\bmarked resolved\b/,
  /\bthread resolved\b/,
  /\bthat resolves it\b/,
  /\bthis resolves it\b/,
  /\bclosing this out\b/,
  /\bconfirmed fixed\b/,
  // verify clause + a fix/resolve verb, allowing a short gap ("verified at <sha>, that fixes it").
  /\b(verified|confirmed)\b[^.!?]*\b(fix(es|ed)|resolv)/,
  /\b(thanks,?|fixed,?) (looks )?resolved\b/,
]

// Casual phrasing that might be chatter, not a formal close-out: allow + nudge.
const WARN: readonly RegExp[] = [
  /\blgtm\b/,
  /\blooks good\b/,
  /\blooks fine\b/,
  /\bseems fine\b/,
  /\bshould be (fine|good)\b/,
  /\bneeds changes\b/,
  /\bstill needs work\b/,
  /\blooks resolved\b/,
  /\bseems resolved\b/,
]

// Negation / future-intent / past-reference markers DEMOTE a positive match to
// ignore. Blocking "I haven't approved" / "I'll approve" / "approved it earlier"
// (answering a question) is the worst false-positive class, so it is checked first.
const DEMOTE_TO_IGNORE: readonly RegExp[] = [
  /\b(haven'?t|have not|did ?n'?t|did not|not yet|never)\b[^.!?]*\b(approv|request|resolv|block)/,
  /\b(can'?t|cannot|won'?t|will not|wouldn'?t)\b[^.!?]*\b(approv|request|resolv|block)/,
  /\bnot (approved|resolved|blocked|requesting)\b/,
  /\b(i'?ll|i will|going to|gonna|about to|planning to)\b[^.!?]*\b(approv|review|request|resolv)/,
  /\b(approved|resolved|requested changes)\b[^.!?]*\b(earlier|already|yesterday|before|last (review|time)|previously)\b/,
]

export function classifyReviewClaim(rawText: string): ReviewClaim {
  const text = normalize(rawText)
  if (text === '') return 'ignore'

  if (DEMOTE_TO_IGNORE.some((re) => re.test(text))) return 'ignore'

  // Block-tier wins over warn-tier: an unambiguous "approved" in a casual message
  // is still a formal claim.
  if (BLOCK_APPROVE.some((re) => re.test(text))) return 'block-approve'
  if (BLOCK_REQUEST_CHANGES.some((re) => re.test(text))) return 'block-request-changes'
  if (BLOCK_RESOLVE.some((re) => re.test(text))) return 'block-resolve'
  if (WARN.some((re) => re.test(text))) return 'warn'
  return 'ignore'
}

// Strips markdown/emoji noise so "**Approved!**" and "approved" classify alike,
// keeping apostrophes + sentence punctuation that the negation regexes rely on.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`~#>]/g, ' ')
    .replace(/[^\p{L}\p{N}\s'.!?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
