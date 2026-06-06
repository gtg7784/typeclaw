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

// Bare "resolved" is intentionally NOT here — it collides with the warn-tier
// "looks resolved?"; resolve claims must carry a definite marker (marked/that/
// this/thanks) or a verify clause. "that/this closes it" is the canonical PR
// #644 incident phrasing and must classify as a close-out claim.
const BLOCK_RESOLVE: readonly RegExp[] = [
  /\bmarked resolved\b/,
  /\bthread resolved\b/,
  /\bthat resolves it\b/,
  /\bthis resolves it\b/,
  /\b(that|this) closes it\b/,
  /\bclosing this out\b/,
  /\bconfirmed fixed\b/,
  // verify clause + a fix/resolve verb, allowing a short gap ("verified at <sha>, that fixes it").
  /\b(verified|confirmed)\b[^.!?]*\b(fix(es|ed)|resolv)/,
  /\b(thanks,?|fixed,?) (looks )?resolved\b/,
]

// Approval/resolve-shaped warn phrases: casual chatter that, on a PR the bot is
// still blocking, READS as a close-out and so can strand the block. Split out so
// the re-review guard can escalate only these — never the negative warn phrases
// below, which re-assert a block rather than strand it.
const WARN_POSITIVE_CLOSEOUT: readonly RegExp[] = [
  /\blgtm\b/,
  /\blooks good\b/,
  /\blooks fine\b/,
  /\bseems fine\b/,
  /\bshould be (fine|good)\b/,
  /\blooks resolved\b/,
  /\bseems resolved\b/,
  // The canonical PR #672 close-out: "that addresses the concern", "addressed
  // your feedback". On a PR the bot still blocks, this READS as a verdict and
  // strands the block, so it escalates through the re-review guard. Demoted to
  // ignore by the negation/future markers below ("haven't addressed", "to
  // address").
  /\baddress(es|ed)\b[^.!?]*\b(concern|feedback|review|comment|issue|point)/,
]

// Negative warn phrases re-assert a block ("not done yet") instead of closing it
// out, so they are NOT close-out attempts — the re-review guard must ignore them.
const WARN_NEGATIVE: readonly RegExp[] = [/\bneeds changes\b/, /\bstill needs work\b/]

const WARN: readonly RegExp[] = [...WARN_POSITIVE_CLOSEOUT, ...WARN_NEGATIVE]

// Negation / future-intent / past-reference markers DEMOTE a positive match to
// ignore. Blocking "I haven't approved" / "I'll approve" / "approved it earlier"
// (answering a question) is the worst false-positive class, so it is checked first.
const DEMOTE_TO_IGNORE: readonly RegExp[] = [
  /\b(haven'?t|have not|did ?n'?t|did not|not yet|never)\b[^.!?]*\b(approv|request|resolv|block|address)/,
  /\b(can'?t|cannot|won'?t|will not|wouldn'?t)\b[^.!?]*\b(approv|request|resolv|block|address)/,
  /\bnot (approved|resolved|blocked|requesting|addressed)\b/,
  /\b(not|no longer|hardly|barely)\b[^.!?]*\b(lgtm|looks good|looks fine|seems fine|should be (fine|good)|looks resolved|seems resolved)\b/,
  /\b(i'?ll|i will|going to|gonna|about to|planning to|need(s)? to|have to|to)\b[^.!?]*\b(approv|review|request|resolv|address)/,
  /\b(approved|resolved|requested changes)\b[^.!?]*\b(earlier|already|yesterday|before|last (review|time)|previously)\b/,
  /\b(pre|self|co|re|un|non|ai|admin|user|machine|auto) approved\b/,
]

const QUESTION_CONTEXT =
  /(?:^|\b)(who|what|when|where|why|how|was|were|is|are|did|do|does|has|have|can|could|would|should)\b[^.!?]*\?/

export function classifyReviewClaim(rawText: string): ReviewClaim {
  const segments = claimSegments(rawText)
  if (segments.length === 0) return 'ignore'

  const claims = segments.map(classifySegment)

  if (claims.includes('block-approve')) return 'block-approve'
  if (claims.includes('block-request-changes')) return 'block-request-changes'
  if (claims.includes('block-resolve')) return 'block-resolve'
  if (claims.includes('warn')) return 'warn'
  return 'ignore'
}

// True only for warn-tier replies whose phrasing reads as an approval/resolve
// close-out (e.g. "looks good", "lgtm"), excluding negative warn phrases like
// "needs changes" that re-assert a block. The re-review guard uses this to
// escalate just the stranding-shaped warns, not the whole warn bucket.
export function isPositiveWarnCloseout(rawText: string): boolean {
  if (classifyReviewClaim(rawText) !== 'warn') return false
  return claimSegments(rawText).some((segment) => WARN_POSITIVE_CLOSEOUT.some((re) => re.test(segment)))
}

function classifySegment(text: string): ReviewClaim {
  if (DEMOTE_TO_IGNORE.some((re) => re.test(text))) return 'ignore'
  if (QUESTION_CONTEXT.test(text)) return 'ignore'

  // Block-tier wins over warn-tier: an unambiguous "approved" in a casual message
  // is still a formal claim.
  if (BLOCK_APPROVE.some((re) => re.test(text))) return 'block-approve'
  if (BLOCK_REQUEST_CHANGES.some((re) => re.test(text))) return 'block-request-changes'
  if (BLOCK_RESOLVE.some((re) => re.test(text))) return 'block-resolve'
  if (WARN.some((re) => re.test(text))) return 'warn'
  return 'ignore'
}

function claimSegments(text: string): string[] {
  return redactQuotedAndCode(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalize)
    .filter((segment) => segment !== '')
}

function redactQuotedAndCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
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
