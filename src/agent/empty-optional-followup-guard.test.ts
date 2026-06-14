import { describe, expect, test } from 'bun:test'

import { stripEmptyOptionalFollowupFiller } from './empty-optional-followup-guard'

describe('stripEmptyOptionalFollowupFiller', () => {
  test('removes a standalone English optional follow-up sentence at the end', () => {
    expect(stripEmptyOptionalFollowupFiller('Done — I updated the config. If you want, I can also add tests.')).toBe(
      'Done — I updated the config.',
    )
  })

  test('removes standalone multilingual optional follow-up sentences at the end', () => {
    expect(stripEmptyOptionalFollowupFiller('설정 업데이트를 완료했습니다. 원하면 테스트도 추가해드릴게요.')).toBe(
      '설정 업데이트를 완료했습니다.',
    )
    expect(stripEmptyOptionalFollowupFiller('設定を更新しました。必要でしたらテストも追加できます。')).toBe(
      '設定を更新しました。',
    )
    expect(stripEmptyOptionalFollowupFiller('配置已更新。如果需要，我也可以添加测试。')).toBe('配置已更新。')
    expect(stripEmptyOptionalFollowupFiller('Listo. Si quieres, también puedo añadir pruebas.')).toBe('Listo.')
    expect(stripEmptyOptionalFollowupFiller('Terminé. Si tu veux, je peux aussi ajouter des tests.')).toBe('Terminé.')
    expect(stripEmptyOptionalFollowupFiller('Fertig. Wenn du möchtest, kann ich auch Tests hinzufügen.')).toBe(
      'Fertig.',
    )
  })

  test('removes optional follow-up paragraphs while keeping the substantive answer', () => {
    expect(stripEmptyOptionalFollowupFiller('The PR is ready.\n\nIf you want, I can prepare a shorter summary.')).toBe(
      'The PR is ready.',
    )
  })

  test('can be disabled for non-GPT providers', () => {
    const text = 'Done — I updated the config. If you want, I can also add tests.'
    expect(stripEmptyOptionalFollowupFiller(text, false)).toBe(text)
  })

  test('preserves legitimate conditionals in substantive content', () => {
    const text = 'If the webhook is disabled, restart is required.'
    expect(stripEmptyOptionalFollowupFiller(text)).toBe(text)
  })

  test('preserves non-tail legitimate conditionals', () => {
    const text = 'If the webhook is disabled, restart is required. I verified the setting.'
    expect(stripEmptyOptionalFollowupFiller(text)).toBe(text)
  })

  test('does not apply a broad phrase ban inside useful content', () => {
    const text = 'Use the --force flag only if you want the command to overwrite local changes.'
    expect(stripEmptyOptionalFollowupFiller(text)).toBe(text)
  })
})
