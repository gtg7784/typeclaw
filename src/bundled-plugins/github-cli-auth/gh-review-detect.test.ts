import { describe, expect, test } from 'bun:test'

import { detectReviewSubmission } from './gh-review-detect'

describe('detectReviewSubmission — REST --input', () => {
  test('APPROVE in the input file is detected', () => {
    const result = detectReviewSubmission({
      command: 'gh api -X POST /repos/acme/widgets/pulls/12/reviews --input /tmp/review-12.json',
      inputFileContents: '{ "event": "APPROVE", "body": "lgtm" }',
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 12, verdict: 'APPROVE' })
  })

  test('REQUEST_CHANGES in the input file is detected', () => {
    const result = detectReviewSubmission({
      command: 'gh api -X POST /repos/acme/widgets/pulls/7/reviews --input /tmp/r.json',
      inputFileContents: '{"event":"REQUEST_CHANGES","comments":[]}',
    })
    expect(result?.verdict).toBe('REQUEST_CHANGES')
  })

  test('a COMMENT review is not tracked', () => {
    const result = detectReviewSubmission({
      command: 'gh api -X POST /repos/acme/widgets/pulls/7/reviews --input /tmp/r.json',
      inputFileContents: '{"event":"COMMENT"}',
    })
    expect(result).toBeNull()
  })

  test('malformed file contents yield null (cannot credit a verdict)', () => {
    const result = detectReviewSubmission({
      command: 'gh api -X POST /repos/acme/widgets/pulls/7/reviews --input /tmp/r.json',
      inputFileContents: 'not json',
    })
    expect(result).toBeNull()
  })
})

describe('detectReviewSubmission — REST inline fields', () => {
  test('-f event=APPROVE (separate value)', () => {
    const result = detectReviewSubmission({
      command: 'gh api /repos/acme/widgets/pulls/3/reviews -f event=APPROVE',
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 3, verdict: 'APPROVE' })
  })

  test('-F event=REQUEST_CHANGES', () => {
    const result = detectReviewSubmission({
      command: 'gh api /repos/acme/widgets/pulls/3/reviews -F event=REQUEST_CHANGES',
    })
    expect(result?.verdict).toBe('REQUEST_CHANGES')
  })

  test('case-insensitive event value', () => {
    const result = detectReviewSubmission({
      command: 'gh api /repos/acme/widgets/pulls/3/reviews -f event=approve',
    })
    expect(result?.verdict).toBe('APPROVE')
  })
})

describe('detectReviewSubmission — gh pr review porcelain', () => {
  test('gh pr review N --approve -R owner/repo', () => {
    const result = detectReviewSubmission({
      command: 'gh pr review 42 --approve -R acme/widgets',
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 42, verdict: 'APPROVE' })
  })

  test('gh pr review --request-changes N --repo owner/repo', () => {
    const result = detectReviewSubmission({
      command: 'gh pr review --request-changes 42 --repo acme/widgets',
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 42, verdict: 'REQUEST_CHANGES' })
  })

  test('gh pr review --comment is not tracked', () => {
    const result = detectReviewSubmission({
      command: 'gh pr review 42 --comment -b "thoughts" -R acme/widgets',
    })
    expect(result).toBeNull()
  })
})

describe('detectReviewSubmission — non-matches', () => {
  test('a plain pr view is null', () => {
    expect(detectReviewSubmission({ command: 'gh pr view 12 -R acme/widgets' })).toBeNull()
  })

  test('a top-level issue comment is null', () => {
    expect(
      detectReviewSubmission({ command: 'gh api -X POST /repos/acme/widgets/issues/12/comments -f body=hi' }),
    ).toBeNull()
  })

  test('reviews endpoint without an event is null', () => {
    expect(
      detectReviewSubmission({ command: 'gh api /repos/acme/widgets/pulls/12/reviews', inputFileContents: null }),
    ).toBeNull()
  })

  test('a non-gh command is null', () => {
    expect(detectReviewSubmission({ command: 'echo gh api reviews event=APPROVE' })).toBeNull()
  })
})
