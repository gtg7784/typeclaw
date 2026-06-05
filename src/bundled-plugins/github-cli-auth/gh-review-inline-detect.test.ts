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

  test('partial inline still blocks on stranded body anchors', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({
        event: 'REQUEST_CHANGES',
        body: DUMPED_BODY,
        comments: [
          { path: 'apps/admin/src/lib/i18n/languages.ts', line: 12, body: 'x' },
          { path: 'apps/admin/src/lib/i18n/translations/en.ts', line: 807, body: 'y' },
          { path: 'apps/admin/src/components/translation-panel.tsx', line: 107, body: 'z' },
        ],
      }),
    })
    expect(result?.block).toBe(true)
  })

  test('span comment does not cover an anchor outside its range', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({
        event: 'REQUEST_CHANGES',
        body: 'a `x.ts:10`\nb `y.ts:20`\nc `z.ts:30`',
        comments: [{ path: 'x.ts', start_line: 10, line: 12, body: 'covers x only' }],
      }),
    })
    expect(result?.block).toBe(true)
  })
})

describe('detectReviewDump — allows legitimate reviews', () => {
  test('every body anchor covered inline (range, list, full-path) is allowed', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({
        event: 'REQUEST_CHANGES',
        body: 'a `languages.ts:12-20`\nb `en.ts:807,809`\nc `panel.tsx:107-111`',
        comments: [
          { path: 'apps/admin/src/lib/i18n/languages.ts', line: 15, body: 'in range' },
          { path: 'apps/admin/src/lib/i18n/translations/en.ts', line: 809, body: 'in list' },
          { path: 'src/components/panel.tsx', line: 107, body: 'at line' },
        ],
      }),
    })
    expect(result).toBeNull()
  })

  test('summary body with no anchors is allowed regardless of comments', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({
        event: 'REQUEST_CHANGES',
        body: 'Two blockers, see inline.',
        comments: [{ path: 'a.ts', line: 12, body: 'x' }],
      }),
    })
    expect(result).toBeNull()
  })

  test('span comment covers an anchor inside its start_line..line range', () => {
    const result = detectReviewDump({
      command: REVIEWS_CMD,
      inputFileContents: payload({
        event: 'REQUEST_CHANGES',
        body: 'a `x.ts:10`\nb `x.ts:20`\nc `x.ts:30`',
        comments: [
          { path: 'x.ts', start_line: 8, line: 12, body: 'covers 10' },
          { path: 'x.ts', line: 20, body: 'covers 20' },
          { path: 'x.ts', line: 30, body: 'covers 30' },
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
