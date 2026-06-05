import { describe, expect, test } from 'bun:test'

import { detectReviewDump } from './gh-review-inline-detect'

const REVIEWS_CMD = 'gh api -X POST /repos/acme/widgets/pulls/7/reviews --input /tmp/r.json'

const DUMPED_BODY = [
  '## Review summary',
  'Two concerns, requesting changes.',
  '### Concern',
  '1. hardcoded display name `apps/admin/src/lib/i18n/languages.ts:12-20`',
  '2. sentence case violation `apps/admin/src/lib/i18n/translations/en.ts:807,809`',
  '### Nit',
  '1. missing aria-expanded (`translation-panel.tsx:107-111`)',
  '2. duplicated markup (`translation-panel.tsx:81-86,97-102`)',
  '3. emoji deprecated (`languages.ts:4`)',
  '4. carousel missing aria-hidden (`translation-panel.tsx:283-309`)',
].join('\n')

function payload(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

describe('detectReviewDump — blocks the dumped review', () => {
  test('REQUEST_CHANGES with many path:line anchors and no inline comments blocks', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({ event: 'REQUEST_CHANGES', body: DUMPED_BODY, comments: [] }),
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('comments[]')
  })

  test('missing comments key is treated as zero inline comments', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({ event: 'REQUEST_CHANGES', body: DUMPED_BODY }),
    })
    expect(result?.block).toBe(true)
  })
})

describe('detectReviewDump — allows legitimate reviews', () => {
  test('REQUEST_CHANGES with findings properly in comments[] is allowed', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({
        event: 'REQUEST_CHANGES',
        body: 'Two blockers, see inline.',
        comments: [
          { path: 'a.ts', line: 12, body: 'x' },
          { path: 'b.ts', line: 8, body: 'y' },
          { path: 'c.ts', line: 3, body: 'z' },
          { path: 'd.ts', line: 1, body: 'w' },
          { path: 'e.ts', line: 4, body: 'v' },
          { path: 'f.ts', line: 9, body: 'u' },
        ],
      }),
    })
    expect(result).toBeNull()
  })

  test('REQUEST_CHANGES with only one anchor is below threshold', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({
        event: 'REQUEST_CHANGES',
        body: 'One concern at `foo.ts:42`, please fix.',
        comments: [],
      }),
    })
    expect(result).toBeNull()
  })

  test('APPROVE with many anchors in a recap is allowed (verdict gate)', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({ event: 'APPROVE', body: DUMPED_BODY, comments: [] }),
    })
    expect(result).toBeNull()
  })

  test('COMMENT review is allowed (verdict gate)', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({ event: 'COMMENT', body: DUMPED_BODY, comments: [] }),
    })
    expect(result).toBeNull()
  })

  test('distinct anchors only: the same anchor repeated is one finding', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({
        event: 'REQUEST_CHANGES',
        body: 'See `foo.ts:10`. Again `foo.ts:10`. And once more `foo.ts:10`.',
        comments: [],
      }),
    })
    expect(result).toBeNull()
  })
})

describe('detectReviewDump — non-matches', () => {
  test('non-reviews endpoint is null', () => {
    const result = detectReviewDump({
      command: 'gh api -X POST /repos/acme/widgets/issues/7/comments -f body=hi',
      inputFileContents: payload({ event: 'REQUEST_CHANGES', body: DUMPED_BODY, comments: [] }),
    })
    expect(result).toBeNull()
  })

  test('no input file contents is null', () => {
    const result = detectReviewDump({ command: REVIEWS_CMD, inputFileContents: null })
    expect(result).toBeNull()
  })

  test('malformed JSON is null', () => {
    const result = detectReviewDump({ command: REVIEWS_CMD, inputFileContents: 'not json' })
    expect(result).toBeNull()
  })
})
