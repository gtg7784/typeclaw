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
