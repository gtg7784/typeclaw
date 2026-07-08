import { describe, expect, test } from 'bun:test'

import { detectContinuationWillingness } from './continuation-willingness'

describe('detectContinuationWillingness — positive (self-directed future intent)', () => {
  const willing: readonly string[] = [
    "I'll continue now.",
    "I'll keep checking the diff.",
    "I'll take a look at the rest.",
    'let me check the other files',
    'Let me verify that real quick',
    'On it now — checking the logs',
    'working on it now, one sec',
    "I'm on it, one sec",
    "I'll investigate the rest",
    "I'll look it up real quick",
    'lemme check the logs',
    'let me pull that up',
    'give me a moment',
    '죄송합니다. 바로 계속 확인하겠습니다.',
    '바로 확인해볼게요',
    '이어서 확인하겠습니다',
    '계속 진행할게요',
    '계속하겠습니다',
    '나머지도 살펴볼게요',
    '잠시만요, 확인 중이에요',
    '바로 `gh`로 확인할게요',
    // Bare-volitional KO acks (the production miss: "…먼저 볼게요" matched nothing
    // because only the "바로 볼게요" compound was listed).
    '확인해볼게요, 이미지랑 타입 기준 먼저 볼게요.',
    '먼저 볼게요',
    '한번 볼게요',
    '검토해볼게요',
    '찾아볼게요',
    '바로 처리할게요',
    // Casual (banmal) -ㄹ게 volitional — the same first-person promise WITHOUT the
    // polite -요. A persona that speaks informally ("확인해볼게!") hit nothing
    // because every KO entry was polite-form; the morpheme pass now covers both.
    // The first entry mirrors the production ack that ended a Discord turn in silence.
    '확인해볼게! GitHub 접근이랑 gh 인증 기준으로 둘 다 빠르게 봐볼게',
    '확인해볼게',
    '살펴볼게',
    '검토해볼게',
    '찾아볼게',
    '계속 진행할게',
    '바로 처리할게',
    '업데이트할게',
    '수정할게',
    // Action/config verb family (English) — "I'll DO X" promises beyond the
    // retrieval verbs. The cron-update production miss is the canonical case.
    "I'll update the cron timing logic.",
    'Let me set up the new cron job now.',
    "I'll fix it right away.",
    "I'll configure the job.",
    // Action/config verb family (Korean) — caught by the -겠습니다 morpheme regex
    // (any verb, not just check/look) and the -게요 action forms.
    '크론 타이밍 로직 반영해두겠습니다.',
    '바로 티켓 AC 업데이트하겠습니다 🙏',
    '설정 값 수정하겠습니다.',
    '업데이트할게요',
  ]

  for (const text of willing) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(true)
    })
  }
})

describe('detectContinuationWillingness — positive (multilingual self-directed future intent)', () => {
  const willing: readonly string[] = [
    'Lo reviso enseguida, un momento.',
    'Voy a verificar el resto.',
    'Je vais vérifier les autres fichiers.',
    'Laisse-moi regarder ça.',
    'Vado a controllare subito.',
    'Vou conferir o restante.',
    'Ich werde das gleich prüfen.',
    'Lass mich nachsehen.',
    'Сейчас проверю остальное.',
    'Я посмотрю и продолжу.',
    '我来确认一下其余的。',
    '我马上检查日志。',
    '確認してみます、少々お待ちください。',
    '引き続き確認します。',
    'سأتحقق من الباقي.',
    'دعني أراجع ذلك.',
    'मैं अभी जाँच करूँगा।',
    'Hemen kontrol ediyorum.',
    'Devam edeceğim, bir saniye.',
    'Để tôi kiểm tra phần còn lại.',
    'Tôi sẽ xem ngay.',
    'Biar saya cek dulu.',
    'Saya akan periksa sisanya.',
    // Gap-closure cases surfaced by a cross-language audit — natural ack phrasings
    // the original tables missed (e.g. "let me take a quick look" idioms and the
    // present-tense "I'm looking at it now" forms each language uses).
    'Ahora lo reviso, dame un segundo.',
    'Voy a echar un vistazo.',
    'Je vais jeter un œil.',
    'Je regarde ça tout de suite.',
    'Je vais creuser un peu.',
    "Vado a dare un'occhiata.",
    'Vou dar uma olhada.',
    'Ich schaue mir das an.',
    'Ich prüfe das gleich.',
    'Дай мне проверить это.',
    '让我查一下。',
    'Bir bakayım.',
    // Action/config verb family across languages — the "I'll DO X" class that the
    // retrieval-only tables missed. Korean/Turkish/Hindi/Japanese hit the morpheme
    // pass; the rest hit the phrase pass.
    'Voy a actualizar la configuración.',
    'Je vais corriger ça.',
    'Ich werde aktualisieren.',
    'Сейчас обновлю конфигурацию.',
    '我来更新一下。',
    '設定を更新します。',
    '対応してみます。',
    'मैं इसे अपडेट करूँगा।',
    'Hemen güncelleyeceğim.',
    'Ayarı yapacağım.',
    'Tôi sẽ cập nhật ngay.',
    'Saya akan perbarui sekarang.',
  ]

  for (const text of willing) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(true)
    })
  }
})

describe('detectContinuationWillingness — negative (final / descriptive / other-directed)', () => {
  const notWilling: readonly string[] = [
    'Done. The diff looks good, no issues.',
    'I checked and it is fine.',
    'You can continue with the merge.',
    'Looks good to me, approving.',
    'ok',
    'done',
    '네',
    '확인 결과 문제 없습니다.',
    '계속 진행하세요.',
    '이대로 진행하셔도 됩니다.',
    '리뷰 완료했습니다. 승인합니다.',
    // Idiomatic -겠습니다 that is NOT volitional work intent: 알겠습니다 = "understood"
    // (a pure ack), 모르겠습니다 = "I don't know". The morpheme regex excludes these.
    '알겠습니다, 감사합니다!',
    '잘 모르겠습니다.',
    // Adjective-stem conjecture/desiderative — 겠 sits on an adjective, not a verb
    // stem, so the verb-anchored regex must not read these as work promises.
    '좋겠어요.',
    '괜찮겠어요.',
    '오늘은 좀 힘들겠습니다.',
    // Bare adverb+noun fragments removed from the KO table — they fire on
    // other-directed requests and descriptive progressives, not self-intent.
    '바로 확인 부탁드려요.',
    '계속 확인 중입니다.',
    // Casual (banmal) idiomatic -겠어 acks — 알겠어 = "got it", 모르겠어 = "dunno".
    // The verb-anchored volitional regex must not read these casual forms as work
    // promises, exactly as it excludes their polite -겠어요/-겠습니다 siblings.
    '알겠어, 고마워!',
    '잘 모르겠어.',
    // Descriptive casual past — an already-done report, not a promise to act.
    '이미 확인했어, 문제 없어.',
    '',
    '...',
  ]

  for (const text of notWilling) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(false)
    })
  }
})

describe('detectContinuationWillingness — negative (multilingual final / descriptive / other-directed)', () => {
  const notWilling: readonly string[] = [
    'Sí, todo bien. Puedes continuar.',
    'Ya lo revisé, está correcto.',
    "Oui, c'est bon. Tu peux continuer.",
    "J'ai vérifié, aucun problème.",
    'Va bene, ho controllato tutto.',
    'Está tudo certo, pode continuar.',
    'Alles gut, ich habe es geprüft.',
    'Да, всё хорошо, можешь продолжать.',
    '好的，我检查过了，没问题。',
    '你可以继续了。',
    'はい、確認しました。問題ありません。',
    'تم، تحققت من كل شيء.',
    'ठीक है, मैंने जाँच लिया।',
    'Tamam, kontrol ettim, sorun yok.',
    'Vâng, tôi đã kiểm tra rồi.',
    'Oke, sudah saya periksa, tidak ada masalah.',
    // Japanese idioms that end in します but are requests/greetings, not work
    // intent — stripped before the morpheme test so they do not fire.
    'お願いします。',
    'よろしくお願いいたします。',
    '失礼します。',
    'どうしますか？',
    'どうします？',
    '更新します？',
  ]

  for (const text of notWilling) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(false)
    })
  }
})
