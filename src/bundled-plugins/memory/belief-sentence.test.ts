import { describe, expect, test } from 'bun:test'

import { firstBeliefSentence, isTitleLikeHeading } from './belief-sentence'

describe('firstBeliefSentence', () => {
  test('returns the belief sentence, skipping citation lists', () => {
    const body = [
      'Peyz is T1 2026 ADC; Gumayusi left T1 for HLE in Nov 2025.',
      '',
      'fragments:',
      '- streams/2026-05-28#019e6dc7-269a-7000-b2ec-0d9475c9abad',
    ].join('\n')

    expect(firstBeliefSentence(body)).toBe('Peyz is T1 2026 ADC; Gumayusi left T1 for HLE in Nov 2025.')
  })

  test('unwraps a leading markdown heading line', () => {
    expect(firstBeliefSentence('## The user always uses pnpm\n\nfragments:\n- streams/2026-01-01#a')).toBe(
      'The user always uses pnpm',
    )
  })

  test('returns a Korean belief sentence intact', () => {
    const body = [
      '페이즈가 2026 T1 원딜이고, 구마유시는 HLE로 이적했다.',
      '',
      'fragments:',
      '- streams/2026-07-02#abc',
    ].join('\n')

    expect(firstBeliefSentence(body)).toBe('페이즈가 2026 T1 원딜이고, 구마유시는 HLE로 이적했다.')
  })

  test('truncates a multi-sentence line to the first sentence only', () => {
    const body = 'Fact one is true. Rationale two explains why.\n\nfragments:\n- streams/2026-01-01#a'

    expect(firstBeliefSentence(body)).toBe('Fact one is true.')
  })

  test('does not split on a decimal point inside the sentence', () => {
    const body = 'The user pins bun to 1.2 for this repo.\n\nfragments:\n- streams/2026-01-01#a'

    expect(firstBeliefSentence(body)).toBe('The user pins bun to 1.2 for this repo.')
  })

  test('truncates at a CJK full stop', () => {
    const body = '페이즈가 T1 원딜이다。구마유시는 HLE로 갔다。\n\nfragments:\n- streams/2026-07-02#abc'

    expect(firstBeliefSentence(body)).toBe('페이즈가 T1 원딜이다。')
  })

  test('returns undefined for a citations-only body', () => {
    expect(
      firstBeliefSentence('fragments:\n- streams/2026-01-01#a\n\nsuperseded:\n- streams/2026-01-01#b'),
    ).toBeUndefined()
  })

  test('skips a references heading', () => {
    const body = ['references:', 'the actual belief', 'fragments:', '- streams/2026-01-01#a'].join('\n')

    expect(firstBeliefSentence(body)).toBe('the actual belief')
  })
})

describe('isTitleLikeHeading', () => {
  test('a slug-echoing title is title-like', () => {
    expect(isTitleLikeHeading('T1 Competition Status 2026', 't1-competition-status-2026')).toBe(true)
  })

  test('a belief sentence is not title-like', () => {
    expect(isTitleLikeHeading('Peyz is T1 2026 ADC; Gumayusi left for HLE.', 't1-competition-status-2026')).toBe(false)
  })

  test('a Korean heading is never title-like (non-ASCII survives slugification)', () => {
    expect(isTitleLikeHeading('페이즈가 2026 T1 원딜이다', 'untitled-abc123')).toBe(false)
  })
})
