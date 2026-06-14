import { describe, expect, test } from 'bun:test'

import { stripEmptyOptionalFollowupFiller } from './empty-optional-followup-guard'

describe('stripEmptyOptionalFollowupFiller', () => {
  test('removes a standalone English optional follow-up sentence at the end', () => {
    expect(stripEmptyOptionalFollowupFiller('Done — I updated the config. If you want, I can also add tests.')).toBe(
      'Done — I updated the config.',
    )
  })

  test('removes a standalone Korean optional follow-up sentence at the end', () => {
    expect(stripEmptyOptionalFollowupFiller('설정 업데이트를 완료했습니다. 원하면 테스트도 추가해드릴게요.')).toBe(
      '설정 업데이트를 완료했습니다.',
    )
  })

  test('removes optional follow-up paragraphs while keeping the substantive answer', () => {
    expect(stripEmptyOptionalFollowupFiller('The PR is ready.\n\nIf you want, I can prepare a shorter summary.')).toBe(
      'The PR is ready.',
    )
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
