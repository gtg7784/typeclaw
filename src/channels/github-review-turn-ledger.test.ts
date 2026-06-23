import { afterEach, describe, expect, test } from 'bun:test'

import {
  __resetReviewObserverForTest,
  hasResolvedThread,
  hasReview,
  recordResolvedThread,
  recordReview,
  resetReviewTurn,
  setReviewObserver,
} from './github-review-turn-ledger'

const S1 = 'ses_one'
const S2 = 'ses_two'
const WS = 'acme/widgets'

afterEach(() => {
  resetReviewTurn(S1)
  resetReviewTurn(S2)
  __resetReviewObserverForTest()
})

describe('review ledger', () => {
  test('records and reads back a verdict for the same pr', () => {
    recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(true)
  })

  test('a recorded APPROVE does not satisfy a REQUEST_CHANGES query', () => {
    recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'REQUEST_CHANGES' })).toBe(false)
  })

  test('verdicts are isolated per pr number', () => {
    recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 99, verdict: 'APPROVE' })).toBe(false)
  })

  test('verdicts are isolated per session', () => {
    recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S2, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(false)
  })

  test('resetReviewTurn clears only the target session', () => {
    recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    recordReview({ sessionId: S2, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    resetReviewTurn(S1)
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(false)
    expect(hasReview({ sessionId: S2, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(true)
  })
})

describe('review observer', () => {
  test('fires the observer with the landed verdict on recordReview', () => {
    const seen: unknown[] = []
    setReviewObserver((args) => seen.push(args))
    recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(seen).toEqual([{ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' }])
  })

  test('a thrown observer never breaks the ledger record', () => {
    setReviewObserver(() => {
      throw new Error('boom')
    })
    expect(() => recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).not.toThrow()
    // the record still landed despite the observer throwing
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(true)
  })

  test('__resetReviewObserverForTest detaches the observer', () => {
    const seen: unknown[] = []
    setReviewObserver((args) => seen.push(args))
    __resetReviewObserverForTest()
    recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(seen).toEqual([])
  })

  test('recordResolvedThread does not fire the verdict observer', () => {
    const seen: unknown[] = []
    setReviewObserver((args) => seen.push(args))
    recordResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })
    expect(seen).toEqual([])
  })
})

describe('resolved-thread ledger', () => {
  test('records and reads back a resolved thread', () => {
    recordResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })
    expect(hasResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })).toBe(true)
  })

  test('a different root comment is not considered resolved', () => {
    recordResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })
    expect(hasResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '777' })).toBe(false)
  })

  test('resetReviewTurn clears resolved threads for the session', () => {
    recordResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })
    resetReviewTurn(S1)
    expect(hasResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })).toBe(false)
  })
})
