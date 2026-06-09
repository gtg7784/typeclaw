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
    'give me a moment',
    '죄송합니다. 바로 계속 확인하겠습니다.',
    '바로 확인해볼게요',
    '이어서 확인하겠습니다',
    '계속 진행할게요',
    '계속하겠습니다',
    '나머지도 살펴볼게요',
    '잠시만요, 확인 중이에요',
    '바로 `gh`로 확인할게요',
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
  ]

  for (const text of notWilling) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(false)
    })
  }
})
