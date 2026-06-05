import { describe, expect, test } from 'bun:test'

import { classifyReviewClaim, isPositiveWarnCloseout, type ReviewClaim } from './github-review-claim'

const cases: ReadonlyArray<[string, ReviewClaim]> = [
  ['Approved!', 'block-approve'],
  ['**Approved** — nice work', 'block-approve'],
  ['I approve this PR', 'block-approve'],
  ['Approving now.', 'block-approve'],
  ['Approval submitted ✅', 'block-approve'],
  ['LGTM, approved', 'block-approve'],

  ['Requesting changes here.', 'block-request-changes'],
  ['Changes requested — see inline.', 'block-request-changes'],
  ['I request changes on this.', 'block-request-changes'],
  ['Blocking this PR until the leak is fixed.', 'block-request-changes'],

  // block-resolve
  ['Verified at abc123, that fixes it. Thanks!', 'block-resolve'],
  ['Thanks, looks resolved.', 'block-resolve'],
  ['Marked resolved.', 'block-resolve'],
  ['That resolves it — closing this out.', 'block-resolve'],
  ['Verified — that closes it, thanks!', 'block-resolve'],
  ['Confirmed fixed.', 'block-resolve'],

  // warn: soft signals, allowed through with a nudge
  ['LGTM', 'warn'],
  ['looks good', 'warn'],
  ['Looks good to me!', 'warn'],
  ['seems fine', 'warn'],
  ['this needs changes IMO', 'warn'],
  ['looks resolved?', 'warn'],

  ["I haven't approved yet — still reviewing.", 'ignore'],
  ['I cannot approve this until tests pass.', 'ignore'],
  ['not approved', 'ignore'],
  ["I'll approve once CI is green.", 'ignore'],
  ['Going to review this shortly.', 'ignore'],
  ['I approved it earlier, in my last review.', 'ignore'],
  ['Yes, I requested changes yesterday.', 'ignore'],
  ['not LGTM yet — tests are still red', 'ignore'],
  ['This is not looks good territory yet.', 'ignore'],
  ['Please do not just say `LGTM`; submit the review.', 'ignore'],
  ['The comment "LGTM" is not enough here.', 'ignore'],
  ['Was this approved already?', 'ignore'],
  ['Who approved this?', 'ignore'],
  ['The pre-approved template text is unrelated.', 'ignore'],
  ['I confirmed the issue is not resolved yet.', 'ignore'],
  ['Can you clarify the second point?', 'ignore'],
  ['', 'ignore'],
]

describe('classifyReviewClaim', () => {
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} → ${expected}`, () => {
      expect(classifyReviewClaim(text)).toBe(expected)
    })
  }

  test('block-tier outranks an embedded warn phrase', () => {
    // given a message carrying both a soft signal and a hard approval claim
    // when classified
    // then the hard claim wins
    expect(classifyReviewClaim('looks good — approved!')).toBe('block-approve')
  })

  test('negation demotes even when a block phrase is present', () => {
    expect(classifyReviewClaim("looks good but I haven't approved it")).toBe('ignore')
  })

  test('separate non-negated sentence can still carry the receipt', () => {
    expect(classifyReviewClaim("I didn't approve the previous revision. This one is approved.")).toBe('block-approve')
    expect(classifyReviewClaim("I haven't approved yet. LGTM on the current diff.")).toBe('warn')
  })
})

describe('isPositiveWarnCloseout', () => {
  test.each(['LGTM', 'looks good', 'looks fine', 'seems fine', 'should be good', 'looks resolved'])(
    'true for approval/resolve-shaped warn: %p',
    (text) => {
      expect(isPositiveWarnCloseout(text)).toBe(true)
    },
  )

  test.each(['this needs changes IMO', 'still needs work here'])(
    'false for negative warn that re-asserts a block: %p',
    (text) => {
      expect(isPositiveWarnCloseout(text)).toBe(false)
    },
  )

  test.each(['Approved!', 'Confirmed fixed.', 'Can you clarify the second point?', ''])(
    'false for non-warn tiers: %p',
    (text) => {
      expect(isPositiveWarnCloseout(text)).toBe(false)
    },
  )
})
