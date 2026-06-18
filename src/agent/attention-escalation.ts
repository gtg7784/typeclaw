import type { ThinkingLevel } from '@mariozechner/pi-agent-core'

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Human attention-escalation is a budget hint, not a command. Keep phrases narrow:
// explicit demands for care, or clear dissatisfaction directed at this response.
const EN_PHRASES: readonly string[] = [
  'do it properly',
  'do it right',
  'do it correctly',
  'be careful',
  'be thorough',
  'think hard',
  'think harder',
  'think carefully',
  'more carefully',
  'ultrathink',
  'ultrawork',
  'ultracode',
  'wtf',
  'what the fuck',
  'what the hell',
  'what are you doing',
  'what are u doing',
  'this is wrong',
  "that's wrong",
  'ffs',
  'for fucks sake',
  'shit',
  'this is shit',
  'are you serious',
  'seriously?',
]

const KO_PHRASES: readonly string[] = [
  '제대로 해',
  '제대로 좀',
  '똑바로 해',
  '똑바로 좀',
  '잘 좀',
  '잘 해',
  '신중하게',
  '꼼꼼하게',
  '뭐하는 거야',
  '뭐하는거야',
  '뭐 하는 거야',
  '아 진짜',
  '장난해',
  '장난하냐',
  '이게 뭐야',
  '똑바로 안 해',
]

const ES_PHRASES: readonly string[] = [
  'hazlo bien',
  'hazlo correctamente',
  'con cuidado',
  'piensa bien',
  'qué haces',
  'que haces',
  'qué mierda',
  'que mierda',
  'en serio',
  'esto está mal',
  'esto esta mal',
]

const FR_PHRASES: readonly string[] = [
  'fais-le correctement',
  'fais-le bien',
  'sois attentif',
  'réfléchis bien',
  'reflechis bien',
  "qu'est-ce que tu fais",
  'c’est nul',
  "c'est nul",
  'sérieusement',
  'serieusement',
  'c’est faux',
  "c'est faux",
]

const IT_PHRASES: readonly string[] = [
  'fallo bene',
  'con attenzione',
  'pensa bene',
  'ma che fai',
  'che cavolo',
  'sul serio',
  'è sbagliato',
  'e sbagliato',
]

const PT_PHRASES: readonly string[] = [
  'faça direito',
  'faca direito',
  'faça corretamente',
  'faca corretamente',
  'com cuidado',
  'pense bem',
  'que isso',
  'que merda',
  'está errado',
  'esta errado',
]

const DE_PHRASES: readonly string[] = [
  'mach es richtig',
  'sei gründlich',
  'sei gruendlich',
  'denk nach',
  'sorgfältig',
  'sorgfaeltig',
  'was machst du',
  'was soll das',
  'ernsthaft',
  'das ist falsch',
]

const RU_PHRASES: readonly string[] = [
  'сделай правильно',
  'сделай как надо',
  'внимательно',
  'тщательно',
  'что ты делаешь',
  'что за',
  'серьёзно',
  'серьезно',
  'это неправильно',
]

const ZH_PHRASES: readonly string[] = [
  '认真做',
  '好好做',
  '仔细点',
  '用心做',
  '搞什么',
  '搞什么鬼',
  '你在干什么',
  '什么鬼',
  '认真的吗',
]

const JA_PHRASES: readonly string[] = [
  'ちゃんとやって',
  'しっかりやって',
  '真面目にやって',
  '丁寧に',
  '何やってんの',
  '何してるの',
  'ふざけてるの',
  'マジで',
  'ちゃんとして',
]

const AR_PHRASES: readonly string[] = ['اعملها صح', 'بعناية', 'فكر جيدا', 'ماذا تفعل', 'ما هذا', 'بجدية', 'هذا خطأ']

const HI_PHRASES: readonly string[] = ['ठीक से करो', 'ध्यान से', 'अच्छे से करो', 'क्या कर रहे हो', 'यह गलत है', 'सच में']

const TR_PHRASES: readonly string[] = [
  'düzgün yap',
  'duzgun yap',
  'doğru yap',
  'dogru yap',
  'dikkatli ol',
  'iyice düşün',
  'iyice dusun',
  'ne yapıyorsun',
  'ne yapiyorsun',
  'ne saçmalık',
  'ne sacmalik',
  'cidden mi',
  'bu yanlış',
  'bu yanlis',
]

const VI_PHRASES: readonly string[] = [
  'làm cho đúng',
  'lam cho dung',
  'làm cẩn thận',
  'lam can than',
  'suy nghĩ kỹ',
  'suy nghi ky',
  'đang làm gì vậy',
  'dang lam gi vay',
  'cái gì vậy',
  'cai gi vay',
  'nghiêm túc',
  'nghiem tuc',
  'sai rồi',
  'sai roi',
]

const ID_PHRASES: readonly string[] = [
  'lakukan dengan benar',
  'hati-hati',
  'pikirkan baik-baik',
  'lagi ngapain',
  'apa-apaan',
  'ini salah',
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

const MORPHEME_PATTERNS: readonly RegExp[] = []

const MIN_LENGTH = 3

export function detectAttentionEscalation(text: string): boolean {
  if (text.length < MIN_LENGTH) return false
  const normalized = normalize(text)
  if (normalized.length < MIN_LENGTH) return false
  if (ALL_PHRASES.some((phrase) => normalized.includes(phrase))) return true
  return MORPHEME_PATTERNS.some((pattern) => pattern.test(normalized))
}

// Not `xhigh`: that level is OpenAI-family-only. `high` is universal and
// `setThinkingLevel` clamps it down per-model, so it's safe to pass unconditionally.
const ESCALATED_LEVEL: ThinkingLevel = 'high'

export function resolveTurnThinkingLevel(
  text: string,
  sessionDefault: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  return detectAttentionEscalation(text) ? ESCALATED_LEVEL : sessionDefault
}

type ThinkingLevelSettable = {
  setThinkingLevel(level: ThinkingLevel): void
}

// `setThinkingLevel` only mutates reasoning_effort (a per-request param), so a
// per-turn bump preserves the prompt-prefix cache — no session recreation, no
// model swap. Skipping the call when nothing resolves leaves the SDK default intact.
export function applyTurnThinkingLevel(
  session: ThinkingLevelSettable,
  text: string,
  sessionDefault: ThinkingLevel | undefined,
): void {
  const resolved = resolveTurnThinkingLevel(text, sessionDefault)
  if (resolved !== undefined) session.setThinkingLevel(resolved)
}
