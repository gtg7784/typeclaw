// Deterministic phrase classifier for the false-receipt guard (channel-reply.ts):
// how strongly does a github PR reply CLAIM a formal verdict/close-out it may not
// have actually performed? The taxonomy errs toward WARN over BLOCK on purpose —
// a false block breaks a legitimate reply; a missed soft-fake only loses a nudge.

export type ReviewClaim = 'block-approve' | 'block-request-changes' | 'block-resolve' | 'warn' | 'ignore'

// Word-boundary anchored so "approved" never fires inside "unapproved".
//
// Multilingual policy (read before adding): this classifier can BLOCK a real
// reply, so the bar is precision, never recall. Each non-English BLOCK entry is
// a verdict word a reviewer only utters when actually approving/blocking; bare
// ambiguous words are left to the warn tier. Critically, every language that
// gains a BLOCK/ WARN phrase below ALSO gains the matching negation/future
// demotion in DEMOTE_TO_IGNORE — without that, "I won't approve" in that
// language would block. CJK scripts have no \b word boundary, so CJK verdict
// tokens are multi-character and matched without \b.
const BLOCK_APPROVE: readonly RegExp[] = [
  /\bapproved\b/,
  /\bapproving\b/,
  /\bi approve\b/,
  /\bapproval (submitted|sent|posted)\b/,
  /\bsubmitting (the )?approval\b/,
  /\bformal approval\b/,
  /\blgtm,? approved\b/,
  // es/pt: aprobado/aprobada, aprovado/aprovada
  /\baprob(?:ado|ada)\b/,
  /\baprov(?:ado|ada)\b/,
  // fr: approuvé/approuvée — no trailing \b: JS \b is ASCII-only, so it is not
  // a boundary after the accented é, which would drop the bare "approuvé".
  /\bapprouv[ée]e?/,
  // it: approvato/approvata
  /\bapprovat[oa]\b/,
  // de: genehmigt / freigegeben
  /\bgenehmigt\b/,
  /\bfreigegeben\b/,
  // ru: одобрено / одобряю
  /\u043E\u0434\u043E\u0431\u0440(?:\u0435\u043D\u043E|\u044F\u044E)/,
  // tr: onaylandı / onaylıyorum — trailing \b dropped (ASCII-only \b is not a
  // boundary after the dotless ı).
  /\bonayl(?:and\u0131|\u0131yorum)/,
  // id: disetujui
  /\bdisetujui\b/,
  // vi: đã duyệt / chấp thuận
  /\u0111\u00E3 duy\u1EC7t/,
  // ja: 承認しました / 承認します
  /\u627F\u8A8D\u3057\u307E(?:\u3057\u305F|\u3059)/,
  // zh: 已批准 / 批准了 / 我批准
  /\u5DF2\u6279\u51C6/,
  /\u6279\u51C6\u4E86/,
  /\u6211\u6279\u51C6/,
  // ar: تمت الموافقة / أوافق
  /\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629/,
  // hi: स्वीकृत / मंज़ूर
  /\u0938\u094D\u0935\u0940\u0915\u0943\u0924/,
]

const BLOCK_REQUEST_CHANGES: readonly RegExp[] = [
  /\brequest(ing|ed)? changes\b/,
  /\bchanges requested\b/,
  /\bi request changes\b/,
  /\bblocking (this|the|merge)\b/,
  /\bthis is blocked\b/,
  // es: solicito/solicité cambios, cambios solicitados
  /\bsolicit[oé] cambios\b/,
  /\bcambios solicitados\b/,
  // fr: je demande des modifications, modifications demandées
  /\bje demande des modifications\b/,
  /\bmodifications demand[ée]es\b/,
  // de: änderungen angefordert / erforderlich
  /\b\u00E4nderungen (?:angefordert|erforderlich)\b/,
  // it: modifiche richieste
  /\bmodifiche richieste\b/,
  // pt: alterações solicitadas
  /\baltera[çc][õo]es solicitadas\b/,
  // ru: запрошены изменения / нужны изменения
  /\u0437\u0430\u043F\u0440\u043E\u0448\u0435\u043D\u044B \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F/,
  // ja: 変更を要求します / 修正が必要です
  /\u5909\u66F4\u3092\u8981\u6C42\u3057\u307E\u3059/,
  // zh: 请求修改 / 需要修改
  /\u8BF7\u6C42\u4FEE\u6539/,
  // tr: değişiklik istiyorum / talep edildi
  /\bde\u011Fi\u015Fiklik (?:istiyorum|talep edildi)\b/,
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
  // Close-out chatter per language. These are softer than the BLOCK tier and can
  // be demoted by the negation/future markers below.
  /\bse ve bien\b/, // es looks good
  /\bse ve correcto\b/, // es
  /\b[çc]a me va\b/, // fr looks good to me
  /\bme parece bien\b/, // es seems fine
  /\bva bene\b/, // it fine/ok-ish (close-out reading)
  /\bsieht gut aus\b/, // de looks good
  /\bparece (?:bom|certo)\b/, // pt looks good/right
  /\u0432\u044B\u0433\u043B\u044F\u0434\u0438\u0442 \u0445\u043E\u0440\u043E\u0448\u043E/, // ru looks good
  /\u770B\u8D77\u6765\u4E0D\u9519/, // zh looks good
  /\u554F\u984C\u306A\u3055\u305D\u3046/, // ja seems fine
  /\bsorun yok gibi\b/, // tr seems fine
  /\btampaknya (?:baik|oke)\b/, // id seems good
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
  /\b(i'?ll|i will|going to|gonna|about to|planning to)\b[^.!?]*\b(approv|review|request|resolv)/,
  // "address" demotion is restricted to explicit future/obligation forms only.
  // A standalone `to` marker (e.g. "...to address my feedback") would match
  // hard-claim prose like "Approved — thanks for updating the docs to address
  // my feedback" and demote it to ignore BEFORE the BLOCK_APPROVE check, hiding
  // a real verdict (the recovery path would then post it unguarded — PR #675).
  /\b(i'?ll|i will|going to|gonna|about to|planning to|need(s)? to|have to|want(s)? to|trying to)\b[^.!?]*\baddress/,
  /\b(approved|resolved|requested changes)\b[^.!?]*\b(earlier|already|yesterday|before|last (review|time)|previously)\b/,
  /\b(pre|self|co|re|un|non|ai|admin|user|machine|auto) approved\b/,
  // Multilingual negation / future-intent demotion. Mandatory companions to the
  // multilingual BLOCK/WARN phrases above: each pairs a negation or future
  // marker with an approve/change/resolve/close verb stem in that language so a
  // declined or deferred verdict ("no apruebo", "je vais approuver",
  // "まだ承認していません") never blocks a real reply.
  // es/pt: no / não / todavía / aún / voy a / vou + aprob/aprov/resol/cambios.
  // Portuguese standalone "não" must be its own alternative — Spanish "\bno\b"
  // does not cover it, so "Não aprovado." (not approved) would otherwise hit
  // the new aprovado approval blocker.
  /\b(?:no|n[ãa]o)\b[^.!?]*\b(aprob|aprov|resol|cambios|altera)/,
  /\b(todav[íi]a no|a[úu]n no|ainda n[ãa]o)\b[^.!?]*\b(aprob|aprov|resol)/,
  /\b(voy a|vou)\b[^.!?]*\b(aprob|aprov|revisar|resolver)/,
  // fr: ne…pas / pas encore / je vais + approuv/résol/modif
  /\bpas (?:encore )?\b[^.!?]*\b(approuv|r[ée]sol|modif)/,
  /\bje vais\b[^.!?]*\b(approuv|revoir|r[ée]sol)/,
  // it: non / non ancora / sto per + approv/risol/modif
  /\bnon (?:ancora )?\b[^.!?]*\b(approv|risol|modif)/,
  // de: nicht / noch nicht / werde + genehm/freigeb/änder
  /\b(?:noch )?nicht\b[^.!?]*\b(genehm|freigeb|\u00E4nder)/,
  /\bich werde\b[^.!?]*\b(genehm|freigeb|pr[üu]f)/,
  // ru: не / ещё не / пока не (одобр/измен/реш)
  /\u043D\u0435\s[^.!?]*(\u043E\u0434\u043E\u0431\u0440|\u0438\u0437\u043C\u0435\u043D|\u0440\u0435\u0448)/,
  // ja: まだ…ません / ていない (not yet approved/resolved)
  /\u307E\u3060[^.!?]*(\u307E\u305B\u3093|\u3066\u3044\u306A\u3044)/,
  // zh: 还没/不/未 + 批准/修改/解决
  /(?:\u8FD8\u6CA1|\u4E0D|\u672A)[^.!?]*(\u6279\u51C6|\u4FEE\u6539|\u89E3\u51B3)/,
  // tr: değil / henüz / -mayacağım (onayla/değişiklik)
  /\b(?:hen[üu]z|de\u011Fil)\b[^.!?]*\b(onayl|de\u011Fi\u015Fik)/,
  // id: belum / tidak + setuju/ubah/selesai
  /\b(?:belum|tidak)\b[^.!?]*\b(setuju|ubah|selesai)/,
  // vi: chưa / không + duyệt
  /(?:ch\u01B0a|kh\u00F4ng)[^.!?]*duy\u1EC7t/,
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
