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
  "i'm on it",
  'give me a moment',
  'give me a sec',
  // Parity additions for common first-person-future acks: "investigate / look up
  // / pull up" are work-verb siblings of the "look into / dig in" entries above,
  // and "lemme" is the contracted "let me" that chat models routinely emit.
  "i'll investigate",
  "i'll look it up",
  "i'll pull that up",
  "i'll pull it up",
  'let me pull',
  'lemme check',
  'lemme look',
  'lemme take a look',
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
  // Bare first-person-volitional verb endings: the -ㄹ게요/-겠습니다 ending is
  // self-directed regardless of the preceding adverb, so the "바로 …" prefix in
  // the entries above is not load-bearing. "볼게요" alone (and "먼저/한번/지금 볼게요"
  // by substring) is the exact production miss — the ack "…먼저 볼게요" did not
  // match because only the "바로 볼게요" compound was listed. Common work verbs
  // (검토/조회/찾아/알아/처리) in the same volitional form join here for parity with
  // "확인/살펴" above; "볼게여" is the casual -여 variant seen in chat.
  '볼게요',
  '볼게여',
  '확인할게여',
  '검토할게요',
  '검토해볼게요',
  '검토하겠습니다',
  '조회해볼게요',
  '조회하겠습니다',
  '찾아볼게요',
  '찾아보겠습니다',
  '알아볼게요',
  '알아보겠습니다',
  '처리할게요',
  '처리하겠습니다',
]

// The remaining languages mirror the precision-first selection above: every
// entry pairs a FIRST-PERSON future/volitional anchor with a work verb
// (check/look/continue/proceed/verify) or is an immediate-work idiom ("on it
// now"). The same false-negative bias holds — bare verbs, bare acknowledgments
// ("ok", "sí", "好"), second-person imperatives ("you continue"), and
// descriptive past forms ("I checked") are deliberately excluded because a
// substring match on those would mis-fire. Latin/Cyrillic/Arabic/Indic entries
// are inflected first-person-future forms (or multi-word) so they cannot
// collide with a bare common word; CJK entries are full 4+ character
// intent phrases, never a lone noun.

// Spanish: "voy a" / "déjame" + work verb; "enseguida" (right away) idioms.
const ES_PHRASES: readonly string[] = [
  'voy a revisar',
  'voy a comprobar',
  'voy a verificar',
  'voy a mirar',
  'voy a continuar',
  'voy a seguir',
  'déjame revisar',
  'déjame comprobar',
  'déjame verificar',
  'déjame mirar',
  'voy a echar un vistazo',
  'déjame echar un vistazo',
  'ahora lo reviso',
  'ahora reviso',
  'ahora lo verifico',
  'ahora mismo lo reviso',
  'lo reviso enseguida',
  'lo verifico enseguida',
  'enseguida lo reviso',
  'enseguida reviso',
  'un momento',
  'dame un momento',
  'dame un segundo',
]

// French: "je vais" + work verb; "laisse-moi" idioms.
const FR_PHRASES: readonly string[] = [
  'je vais vérifier',
  'je vais regarder',
  'je vais continuer',
  'je vais poursuivre',
  'je vais voir',
  'je vais contrôler',
  'je vais creuser',
  'je vais jeter un œil',
  'laisse-moi vérifier',
  'laisse-moi regarder',
  'laisse-moi jeter un œil',
  'je vérifie tout de suite',
  'je regarde tout de suite',
  'je regarde ça tout de suite',
  'je regarde ça',
  'un instant',
  'donne-moi un instant',
  'donne-moi une seconde',
]

// Italian: "vado a" / "fammi" + work verb; "controllo subito" idioms.
const IT_PHRASES: readonly string[] = [
  'vado a controllare',
  'vado a verificare',
  'vado a guardare',
  "vado a dare un'occhiata",
  'fammi controllare',
  'fammi verificare',
  'fammi guardare',
  "fammi dare un'occhiata",
  "do un'occhiata",
  'controllo subito',
  'verifico subito',
  'continuo subito',
  'guardo subito',
  'un momento',
  'dammi un momento',
  'dammi un secondo',
]

// Portuguese: "vou" + work verb; "deixa eu" idioms.
const PT_PHRASES: readonly string[] = [
  'vou verificar',
  'vou checar',
  'vou conferir',
  'vou olhar',
  'vou continuar',
  'vou prosseguir',
  'vou dar uma olhada',
  'deixa eu verificar',
  'deixa eu conferir',
  'deixa eu olhar',
  'deixa eu dar uma olhada',
  'verifico já',
  'já verifico',
  'um momento',
  'me dê um momento',
  'me dá um segundo',
]

// German: "ich werde" / "lass mich" + work verb; "ich schaue gleich" idioms.
const DE_PHRASES: readonly string[] = [
  'ich werde prüfen',
  'ich werde überprüfen',
  'ich werde nachsehen',
  'ich werde weitermachen',
  'ich werde fortfahren',
  'lass mich prüfen',
  'lass mich nachsehen',
  'lass mich schauen',
  'ich schaue gleich',
  'ich schaue mir das an',
  'ich schaue mir das mal an',
  'ich prüfe gleich',
  'ich prüfe das gleich',
  'ich sehe gleich nach',
  'gleich prüfen',
  'gleich überprüfen',
  'gleich nachsehen',
  'einen moment',
  'einen augenblick',
  'gib mir eine sekunde',
]

// Russian: first-person-future verbs (проверю/посмотрю/продолжу) — the -ю/-у
// inflection is unambiguously "I will", so it is a safe self-anchor.
const RU_PHRASES: readonly string[] = [
  'сейчас проверю',
  'я проверю',
  'я посмотрю',
  'я продолжу',
  'продолжу проверку',
  'сейчас посмотрю',
  'дай мне проверить',
  'дайте мне проверить',
  'дайте мне минуту',
  'одну секунду',
  'минутку',
]

// Chinese: 我会/我来/我再 + work verb. Full multi-character intent phrases only;
// no bare nouns. 继续 alone is excluded (could be "you continue").
const ZH_PHRASES: readonly string[] = [
  '我来确认',
  '我来检查',
  '我来看看',
  '我会确认',
  '我会检查',
  '我会继续',
  '我再确认',
  '我再检查',
  '我继续确认',
  '我马上确认',
  '我马上检查',
  '我马上看',
  '让我看看',
  '让我查一下',
  '让我确认一下',
  '让我检查一下',
  '稍等一下',
  '我看一下',
]

// Japanese: -てみます / -します first-person volitional on check/look/continue.
// Bare nouns (確認) are excluded; the verb ending carries the self-direction.
const JA_PHRASES: readonly string[] = [
  '確認します',
  '確認してみます',
  '確認いたします',
  '調べてみます',
  '調べます',
  '見てみます',
  '続けます',
  '引き続き確認します',
  'すぐ確認します',
  '少々お待ちください',
  'ちょっと待ってください',
]

// Arabic: future particle سـ prefixed first-person verb (سأتحقق = "I will
// verify"). The سأ prefix is unambiguously first-person-future.
const AR_PHRASES: readonly string[] = [
  'سأتحقق',
  'سأتأكد',
  'سأراجع',
  'سأطلع',
  'سأكمل',
  'سأواصل',
  'دعني أتحقق',
  'دعني أراجع',
  'لحظة من فضلك',
]

// Hindi: first-person-future "मैं … करूँगा/देखूँगा" forms (multi-word so they
// cannot collide with a bare common word).
const HI_PHRASES: readonly string[] = [
  'जाँच करूँगा',
  'जांच करूंगा',
  'देख लूँगा',
  'देख लूंगा',
  'जारी रखूँगा',
  'जारी रखूंगा',
  'एक मिनट रुकिए',
]

// Turkish: first-person-future "-eceğim/-acağım" on check/look/continue verbs.
const TR_PHRASES: readonly string[] = [
  'kontrol edeceğim',
  'kontrol ediyorum',
  'bakacağım',
  'bir bakayım',
  'bir kontrol edeyim',
  'kontrol edeyim',
  'inceleyeceğim',
  'devam edeceğim',
  'hemen kontrol ediyorum',
  'hemen bakıyorum',
  'bir saniye',
  'bir dakika',
]

// Vietnamese: "tôi sẽ" / "để tôi" (I will / let me) + work verb.
const VI_PHRASES: readonly string[] = [
  'tôi sẽ kiểm tra',
  'tôi sẽ xem',
  'tôi sẽ tiếp tục',
  'để tôi kiểm tra',
  'để tôi xem',
  'tôi kiểm tra ngay',
  'tôi xem ngay',
  'chờ một chút',
  'đợi một chút',
]

// Indonesian: "saya akan" / "biar saya" (I will / let me) + work verb.
const ID_PHRASES: readonly string[] = [
  'saya akan periksa',
  'saya akan cek',
  'saya akan lihat',
  'saya akan lanjutkan',
  'biar saya periksa',
  'biar saya cek',
  'saya cek dulu',
  'saya periksa dulu',
  'tunggu sebentar',
  'sebentar ya',
]

const ALL_PHRASES: readonly string[] = [
  ...EN_PHRASES,
  ...KO_PHRASES,
  ...ES_PHRASES,
  ...FR_PHRASES,
  ...IT_PHRASES,
  ...PT_PHRASES,
  ...DE_PHRASES,
  ...RU_PHRASES,
  ...ZH_PHRASES,
  ...JA_PHRASES,
  ...AR_PHRASES,
  ...HI_PHRASES,
  ...TR_PHRASES,
  ...VI_PHRASES,
  ...ID_PHRASES,
]

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
