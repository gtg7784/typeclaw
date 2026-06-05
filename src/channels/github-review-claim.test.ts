import { describe, expect, test } from 'bun:test'

import { classifyReviewClaim, type ReviewClaim } from './github-review-claim'

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
})
