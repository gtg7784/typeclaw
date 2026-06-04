import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hasReview, resetReviewTurn } from '@/channels/github-review-turn-ledger'
import type { ToolResult } from '@/plugin'

import { commitReviewIfSucceeded, noteReviewCommand } from './review-recorder'

const SESSION = 'ses_recorder'
const WS = 'acme/widgets'

afterEach(() => resetReviewTurn(SESSION))

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
})
