import { describe, expect, test } from 'bun:test'

import { detectReviewSubmission } from './gh-review-detect'

describe('detectReviewSubmission — REST --input', () => {
  test('APPROVE in the input file is detected', () => {
    const result = detectReviewSubmission({
      command: 'gh api -X POST /repos/acme/widgets/pulls/12/reviews --input /tmp/review-12.json',
      inputFileContents: '{ "event": "APPROVE", "body": "lgtm" }',
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 12, verdict: 'APPROVE', source: 'api' })
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
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 3, verdict: 'APPROVE', source: 'api' })
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
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 42, verdict: 'APPROVE', source: 'pr-review' })
  })

  test('gh pr review --request-changes N --repo owner/repo', () => {
    const result = detectReviewSubmission({
      command: 'gh pr review --request-changes 42 --repo acme/widgets',
    })
    expect(result).toEqual({
      workspace: 'acme/widgets',
      prNumber: 42,
      verdict: 'REQUEST_CHANGES',
      source: 'pr-review',
    })
  })

  test('gh pr review --comment is not tracked', () => {
    const result = detectReviewSubmission({
      command: 'gh pr review 42 --comment -b "thoughts" -R acme/widgets',
    })
    expect(result).toBeNull()
  })
})

describe('detectReviewSubmission — gh not at the start of the command', () => {
  test('compound: cd /agent && gh api ... -f event=APPROVE (slash-less endpoint)', () => {
    const result = detectReviewSubmission({
      command: "cd /agent && gh api -X POST repos/acme/widgets/pulls/224/reviews -f event=APPROVE -f body='ok'",
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 224, verdict: 'APPROVE', source: 'api' })
  })

  test('compound with semicolon: cd /agent; gh pr review N --request-changes', () => {
    const result = detectReviewSubmission({
      command: 'cd /agent; gh pr review 224 --repo acme/widgets --request-changes',
    })
    expect(result).toEqual({
      workspace: 'acme/widgets',
      prNumber: 224,
      verdict: 'REQUEST_CHANGES',
      source: 'pr-review',
    })
  })

  test('var-prefixed: tmp=$(mktemp) && gh api ... --input "$tmp" resolves the file verdict', () => {
    const result = detectReviewSubmission({
      command:
        'tmp=$(mktemp /tmp/review-XXXX.json) && gh api -X POST /repos/acme/widgets/pulls/224/reviews --input "$tmp"',
      inputFileContents: '{"event":"APPROVE","body":"verified"}',
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 224, verdict: 'APPROVE', source: 'api' })
  })

  test('heredoc payload then gh --input on a later line resolves the file verdict', () => {
    const result = detectReviewSubmission({
      command:
        "cat > /tmp/review.json <<'JSON'\n" +
        '{"event":"APPROVE","body":"looks good"}\n' +
        'JSON\n' +
        'gh api -X POST /repos/acme/widgets/pulls/224/reviews --input /tmp/review.json',
      inputFileContents: '{"event":"APPROVE","body":"looks good"}',
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 224, verdict: 'APPROVE', source: 'api' })
  })

  test('a quoted body containing "; gh" or a fake endpoint is not mistaken for a second invocation', () => {
    const result = detectReviewSubmission({
      command:
        "gh api -X POST /repos/acme/widgets/pulls/3/reviews -f event=APPROVE -f body='see; gh api repos/x/y/pulls/9/reviews -f event=REQUEST_CHANGES'",
    })
    expect(result).toEqual({ workspace: 'acme/widgets', prNumber: 3, verdict: 'APPROVE', source: 'api' })
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
