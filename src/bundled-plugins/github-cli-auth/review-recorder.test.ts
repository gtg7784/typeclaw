import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hasReview, resetReviewTurn } from '@/channels/github-review-turn-ledger'
import type { ToolResult } from '@/plugin'

import { __resetReviewVerdictGuardForTest, createApproveIdempotencyGuard } from './approve-idempotency'
import { commitReviewIfSucceeded, noteReviewCommand } from './review-recorder'

const SESSION = 'ses_recorder'
const WS = 'acme/widgets'

afterEach(() => {
  resetReviewTurn(SESSION)
  __resetReviewVerdictGuardForTest()
})

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

const SUCCESS_OUTPUT = '{"id":1,"node_id":"PRR_abc","state":"APPROVED"}'
const FAILURE_OUTPUT = 'gh: Validation Failed (HTTP 422)'

describe('review recorder', () => {
  test('credits the ledger when an inline-field APPROVE succeeds', async () => {
    await noteReviewCommand({
      callId: 'c1',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c1', result: textResult(SUCCESS_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(true)
  })

  test('does NOT credit when the command failed', async () => {
    await noteReviewCommand({
      callId: 'c2',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c2', result: textResult(FAILURE_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('does NOT credit on an ambiguous result (fail closed)', async () => {
    await noteReviewCommand({
      callId: 'c3',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c3', result: textResult('(no recognizable output)') })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('reads the verdict from an --input file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-rec-'))
    const file = join(dir, 'review.json')
    writeFileSync(file, '{"event":"REQUEST_CHANGES","body":"x"}')
    try {
      await noteReviewCommand({
        callId: 'c4',
        command: `gh api -X POST /repos/${WS}/pulls/9/reviews --input ${file}`,
      })
      commitReviewIfSucceeded({
        sessionId: SESSION,
        callId: 'c4',
        result: textResult('{"node_id":"PRR_z","state":"CHANGES_REQUESTED"}'),
      })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 9, verdict: 'REQUEST_CHANGES' })).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-review gh command is ignored', async () => {
    await noteReviewCommand({ callId: 'c5', command: `gh pr view 5 -R ${WS}` })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c5', result: textResult(SUCCESS_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('credits a `gh pr review --approve` from its porcelain confirmation line', async () => {
    await noteReviewCommand({ callId: 'c6', command: `gh pr review 42 --approve -R ${WS}` })
    commitReviewIfSucceeded({
      sessionId: SESSION,
      callId: 'c6',
      result: textResult(`✓ Approved pull request ${WS}#42`),
    })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'APPROVE' })).toBe(true)
  })

  test('credits a `gh pr review --request-changes` from its porcelain confirmation line', async () => {
    await noteReviewCommand({ callId: 'c7', command: `gh pr review 42 --request-changes -R ${WS}` })
    commitReviewIfSucceeded({
      sessionId: SESSION,
      callId: 'c7',
      result: textResult(`+ Requested changes to pull request ${WS}#42`),
    })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'REQUEST_CHANGES' })).toBe(true)
  })

  test('does NOT credit a porcelain command whose output is missing the confirmation (fail closed)', async () => {
    await noteReviewCommand({ callId: 'c8', command: `gh pr review 42 --approve -R ${WS}` })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c8', result: textResult('(no recognizable output)') })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'APPROVE' })).toBe(false)
  })

  describe('post-execution backstop (pre-detection missed)', () => {
    const LANDED_APPROVED = `{"id":7,"node_id":"PRR_x","state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/77"}`

    test('credits a landed APPROVE from the REST response when no pending entry exists', () => {
      // no noteReviewCommand — simulates a command shape the before-detector missed
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b1', result: textResult(LANDED_APPROVED) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(true)
    })

    test('credits a landed CHANGES_REQUESTED from the REST response', () => {
      const out = `{"state":"CHANGES_REQUESTED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/78"}`
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b2', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 78, verdict: 'REQUEST_CHANGES' })).toBe(true)
    })

    test('does NOT credit when the state is present but a failure marker is also present (fail closed)', () => {
      const out = `gh: Validation Failed (HTTP 422) {"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/79"}`
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b3', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 79, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit a decisive state with no recoverable PR url', () => {
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b4', result: textResult('{"state":"APPROVED"}') })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit a COMMENT review state', () => {
      const out = `{"state":"COMMENTED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/80"}`
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b5', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 80, verdict: 'APPROVE' })).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 80, verdict: 'REQUEST_CHANGES' })).toBe(false)
    })

    test('the pending-entry path takes precedence over the backstop', async () => {
      await noteReviewCommand({ callId: 'b6', command: `gh api /repos/${WS}/pulls/81/reviews -f event=APPROVE` })
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b6', result: textResult(SUCCESS_OUTPUT) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 81, verdict: 'APPROVE' })).toBe(true)
    })

    test('a pending-path commit returns no landedFromResult (release arms the shield)', async () => {
      await noteReviewCommand({ callId: 'b7', command: `gh api /repos/${WS}/pulls/82/reviews -f event=APPROVE` })
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b7', result: textResult(SUCCESS_OUTPUT) })
      expect(result.committed).toBe(true)
      expect(result.landedFromResult).toBeNull()
    })

    test('the backstop result returns landedFromResult for the caller to arm the shield', () => {
      const out = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/83"}`
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b8', result: textResult(out) })
      expect(result.committed).toBe(true)
      expect(result.landedFromResult).toEqual({ workspace: WS, prNumber: 83, verdict: 'APPROVE', source: 'api' })
    })
  })

  // Mirrors the plugin's tool.after wiring (index.ts): commitReviewIfSucceeded ->
  // verdictGuard.noteLandedReview for the backstop path, then the next submission
  // hits guard(). Proves the advertised "arm the dedupe window" actually holds for
  // the fallback path — the gap the reviewer flagged.
  describe('integration: backstop arms the idempotency lag shield', () => {
    function makeGuard(headSha: string | null) {
      return createApproveIdempotencyGuard({
        resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
        resolveHeadSha: async () => headSha,
      })
    }

    test('pre-detection missed, REST response detected, next same-commit APPROVE is blocked while GitHub returns NONE', async () => {
      const guard = makeGuard('sha-abc')
      // given: a verdict landed via a shape the before-detector missed (no pending,
      // no guard() reservation) — only the REST result proves it
      const out = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/90"}`
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'i1', result: textResult(out) })
      // when: the plugin wires the recovered verdict into the guard, as tool.after does
      expect(result.landedFromResult).not.toBeNull()
      if (result.landedFromResult !== null) await guard.noteLandedReview(result.landedFromResult)
      // then: a second engagement turn's same-commit APPROVE is deduped even though
      // GitHub's reviews read still lags (NONE)
      const dup = await guard.guard({ callId: 'i2', workspace: WS, prNumber: 90, verdict: 'APPROVE' })
      expect(dup?.block).toBe(true)
    })
  })
})
