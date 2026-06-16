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
//
// Detection is two-pass: a phrase-substring pass (ALL_PHRASES) for analytic
// languages where future intent is a separate word ("I'll", "voy a", "我会"),
// plus a morpheme pass (MORPHEME_PATTERNS + the Japanese check) for languages
// where it is a verb inflection/affix. The morpheme pass matches the marker
// itself, so it generalizes across EVERY action verb (update/configure/fix/…)
// instead of enumerating each — what the per-verb KO/TR/HI/JA lists used to do
// by hand.

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
  // Action/config verb family. The retrieval verbs above ("check/look/look up")
  // miss the much larger class of "I'll DO X" promises — update/configure/set up/
  // schedule/fix/apply/create — which is exactly the class that silently truncates
  // when the model forgets `continue: true` (the cron-update production miss).
  "i'll update",
  "i'll set up",
  "i'll set it up",
  "i'll configure",
  "i'll schedule",
  "i'll fix",
  "i'll apply",
  "i'll add",
  "i'll create",
  "i'll handle",
  'let me update',
  'let me fix',
  'let me set up',
  'let me configure',
  'let me add',
  'let me create',
  'let me handle',
]

// Korean: the -겠습니다/-겠어요 and -ㄹ게요 verb endings are first-person
// volitional — they cannot address the listener, so they are safe self-direction
// anchors. The -겠습니다/-겠어요 form is matched by MORPHEME_PATTERNS below (it
// generalizes across all action verbs), so only the -게요/-게여 forms and stall
// idioms are enumerated here. Bare adverb+noun fragments ("바로 확인", "계속 확인",
// "곧 알려") are deliberately NOT listed: without the volitional ending they match
// other-directed requests ("바로 확인 부탁드려요" = "please check") and descriptive
// progressives ("계속 확인 중입니다" = "I'm still checking") — the exact false
// positives the design forbids. Their volitional forms are caught by the morpheme
// regex regardless.
const KO_PHRASES: readonly string[] = [
  '확인해볼게요',
  '확인해 볼게요',
  '확인할게요',
  '확인할게여',
  '계속 진행할게요',
  '계속할게요',
  '바로 볼게요',
  '살펴볼게요',
  '볼게요',
  '볼게여',
  '검토할게요',
  '검토해볼게요',
  '조회해볼게요',
  '찾아볼게요',
  '알아볼게요',
  '처리할게요',
  '알려드릴게요',
  // Action/config verb -게요 forms (the -겠습니다 siblings are covered by the
  // morpheme regex; these are the casual-polite variants chat models also emit).
  '업데이트할게요',
  '수정할게요',
  '설정할게요',
  '반영할게요',
  '적용할게요',
  '추가할게요',
  '생성할게요',
  '잠시만요',
  '잠깐만요',
]

// The remaining languages mirror the precision-first selection above: every
// entry pairs a FIRST-PERSON future/volitional anchor with a work verb
// (check/look/continue/proceed/verify or update/configure/fix/create) or is an
// immediate-work idiom ("on it now"). The same false-negative bias holds — bare
// verbs, bare acknowledgments ("ok", "sí", "好"), second-person imperatives ("you
// continue"), and descriptive past forms ("I checked") are deliberately excluded
// because a substring match on those would mis-fire. Latin/Cyrillic/Arabic/Indic
// entries are inflected first-person-future forms (or multi-word) so they cannot
// collide with a bare common word; CJK entries are full 4+ character intent
// phrases, never a lone noun.

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
  // Action/config verb family.
  'voy a actualizar',
  'voy a configurar',
  'voy a corregir',
  'voy a arreglar',
  'voy a crear',
  'voy a añadir',
  'voy a programar',
  'voy a aplicar',
  'déjame actualizar',
  'déjame corregir',
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
  // Action/config verb family.
  'je vais mettre à jour',
  'je vais configurer',
  'je vais corriger',
  'je vais créer',
  'je vais ajouter',
  'je vais programmer',
  'je vais appliquer',
  'laisse-moi corriger',
  'laisse-moi mettre à jour',
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
  // Action/config verb family.
  'vado ad aggiornare',
  'vado a configurare',
  'vado a correggere',
  'vado a creare',
  'vado ad aggiungere',
  'vado ad applicare',
  'fammi aggiornare',
  'fammi correggere',
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
  // Action/config verb family.
  'vou atualizar',
  'vou configurar',
  'vou corrigir',
  'vou criar',
  'vou adicionar',
  'vou agendar',
  'vou aplicar',
  'deixa eu atualizar',
  'deixa eu corrigir',
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
  // Action/config verb family.
  'ich werde aktualisieren',
  'ich werde konfigurieren',
  'ich werde korrigieren',
  'ich werde einrichten',
  'ich werde erstellen',
  'ich werde hinzufügen',
  'ich werde anwenden',
  'lass mich aktualisieren',
  'lass mich korrigieren',
]

// Russian: first-person-future verbs (проверю/посмотрю/продолжу) — the -ю/-у
// inflection is unambiguously "I will", so it is a safe self-anchor. (Note: the
// bare -ю ending is shared with present-imperfective "я делаю" = "I do", so this
// stays an enumerated list rather than a morpheme regex.)
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
  // Action/config verb family (perfective first-person futures).
  'я обновлю',
  'я настрою',
  'я исправлю',
  'я создам',
  'я добавлю',
  'я применю',
  'сейчас обновлю',
  'сейчас исправлю',
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
  // Action/config verb family.
  '我来更新',
  '我会更新',
  '我来配置',
  '我来设置',
  '我会设置',
  '我来修改',
  '我会修改',
  '我来修复',
  '我来创建',
  '我来添加',
  '我马上更新',
  '让我更新',
  '让我改一下',
]

// Japanese: handled by the JA_VOLITIONAL morpheme check below (-します/-いたします/
// -してみます generalizes across all する action verbs). Only the regular-verb
// ます forms (調べます/見てみます/続けます — bare ます is too broad to regex) and
// stall idioms are enumerated here.
const JA_PHRASES: readonly string[] = [
  '調べてみます',
  '調べます',
  '見てみます',
  '続けます',
  '少々お待ちください',
  'ちょっと待ってください',
]

// Arabic: future particle سـ prefixed first-person verb (سأتحقق = "I will
// verify"). The سأ prefix is first-person-future, but as a bare substring it
// collides with the root س-أ-ل ("ask": سألت "I asked", المسألة "the matter"), so
// this stays an enumerated list of full verbs rather than a سأ-prefix regex.
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
  // Action/config verb family.
  'سأحدث',
  'سأحدّث',
  'سأعدل',
  'سأعدّل',
  'سأضبط',
  'سأصلح',
  'سأنشئ',
  'سأضيف',
]

// Hindi: first-person-future is the -ūṅgā/-ūṅgī suffix, matched by
// MORPHEME_PATTERNS below (it covers all X-करना compounds). Only the stall idiom
// is enumerated here.
const HI_PHRASES: readonly string[] = ['एक मिनट रुकिए']

// Turkish: first-person-future "-eceğim/-acağım" is matched by MORPHEME_PATTERNS
// below. The present-progressive ("ediyorum" = "I'm checking now"), optative
// ("bir bakayım" = "let me look"), and stall idioms stay enumerated — the
// progressive -ıyorum ending is too polysemous to regex ("biliyorum" = "I know").
const TR_PHRASES: readonly string[] = [
  'kontrol ediyorum',
  'bir bakayım',
  'bir kontrol edeyim',
  'kontrol edeyim',
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
  // Action/config verb family.
  'tôi sẽ cập nhật',
  'tôi sẽ cấu hình',
  'tôi sẽ sửa',
  'tôi sẽ tạo',
  'tôi sẽ thêm',
  'để tôi cập nhật',
  'để tôi sửa',
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
  // Action/config verb family.
  'saya akan perbarui',
  'saya akan memperbarui',
  'saya akan atur',
  'saya akan konfigurasi',
  'saya akan perbaiki',
  'saya akan buat',
  'saya akan tambah',
  'biar saya perbaiki',
  'biar saya perbarui',
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

// First-person future/volitional realized as a verb inflection or affix (not a
// separate word), so matching the marker generalizes across ALL action verbs.
const MORPHEME_PATTERNS: readonly RegExp[] = [
  // Korean -겠습니다/-겠어요 first-person volitional. Excludes the two idiomatic
  // non-volitional stems: 알겠- ("understood", a pure ack) and 모르겠- ("I don't
  // know"). The conjecture reading of -겠- ("좋겠다" = "that'd be nice") uses the
  // -겠다/-겠네 endings, not the -겠습니다/-겠어요 declaratives matched here.
  /(?<!알)(?<!모르)겠(?:습니다|어요)/,
  // Turkish first-person-singular future "-acağım/-eceğim" ("I will VERB").
  // Vowel harmony yields exactly these two suffixes; the y-buffer
  // ("bekleyeceğim") leaves the suffix intact.
  /acağım|eceğim/,
  // Hindi first-person future "-ūṅgā/-ūṅgī" on any verb, covering all X-करना
  // compounds ("अपडेट करूँगा"). Both nasal spellings (ँ U+0901 / ं U+0902) and
  // both genders (ा/ी) are included.
  /ू[ँं]ग[ाी]/,
]

// Japanese する-verb volitional します/いたします/してみます — covers the action class
// (更新します/設定します/対応します). Bare ます is the universal polite verb ending and
// far too broad to match, so this keys on します specifically. Two request/greeting
// idioms end in します without being work intent — お願い(いた)します ("please") and
// 失礼します ("excuse me") — and are stripped before the test so they don't fire.
const JA_VOLITIONAL_IDIOMS = /お願い(?:いた)?します|失礼します/g
const JA_VOLITIONAL = /します|してみます/

// Reply texts shorter than this are almost always a complete final answer
// ("네", "ok", "done") where a partial match would be noise. The shortest
// legitimate intent phrases ("on it now", "확인할게요") clear this floor.
const MIN_LENGTH = 4

export function detectContinuationWillingness(text: string): boolean {
  if (text.length < MIN_LENGTH) return false
  const normalized = normalize(text)
  if (normalized.length < MIN_LENGTH) return false
  if (ALL_PHRASES.some((phrase) => normalized.includes(phrase))) return true
  if (MORPHEME_PATTERNS.some((pattern) => pattern.test(normalized))) return true
  return JA_VOLITIONAL.test(normalized.replace(JA_VOLITIONAL_IDIOMS, ''))
}
