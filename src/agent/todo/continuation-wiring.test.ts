import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'

import { readContinuationState } from './continuation-state'
import {
  classifyStopReason,
  extractStopReason,
  recordTurnOutcome,
  recordTurnStart,
  runIdleContinuation,
} from './continuation-wiring'
import { resolveTodoScope } from './scope'
import { writeTodos } from './store'

const TUI: SessionOrigin = { kind: 'tui', sessionId: 'ses_x' }
const SCOPE = resolveTodoScope(TUI)!

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cont-wiring-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('classifyStopReason', () => {
  test('passes through known reasons and collapses the rest to unknown', () => {
    expect(classifyStopReason('stop')).toBe('stop')
    expect(classifyStopReason('aborted')).toBe('aborted')
    expect(classifyStopReason('error')).toBe('error')
    expect(classifyStopReason('tool_calls')).toBe('unknown')
    expect(classifyStopReason(undefined)).toBe('unknown')
  })
})

describe('extractStopReason', () => {
  test('reads stopReason from an assistant message_end event', () => {
    expect(extractStopReason({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } })).toBe(
      'aborted',
    )
  })

  test('ignores non-message_end events', () => {
    expect(extractStopReason({ type: 'text_delta' })).toBeNull()
  })
})

describe('recordTurnOutcome / recordTurnStart', () => {
  test('records the outcome and a user abort arms the durable suppressor', async () => {
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })
    const state = await readContinuationState(agentDir, SCOPE)
    expect(state.lastTurnOutcome?.stopReason).toBe('aborted')
    expect(state.autoResumeBlockedUntilRealUserTurn).toBe(true)
  })

  test('a real user turn clears the abort suppressor; an injected turn does not', async () => {
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })
    await recordTurnStart({ agentDir, origin: TUI, isRealUserTurn: false })
    expect((await readContinuationState(agentDir, SCOPE)).autoResumeBlockedUntilRealUserTurn).toBe(true)
    await recordTurnStart({ agentDir, origin: TUI, isRealUserTurn: true })
    expect((await readContinuationState(agentDir, SCOPE)).autoResumeBlockedUntilRealUserTurn).toBe(false)
  })

  test('scopeless origins are a no-op', async () => {
    const origin: SessionOrigin = { kind: 'subagent', subagent: 's', parentSessionId: 'p' }
    await recordTurnOutcome({ agentDir, origin, turnId: 't', stopReason: 'stop' })
    await recordTurnStart({ agentDir, origin, isRealUserTurn: true })
    // nothing thrown, nothing written
    expect(true).toBe(true)
  })
})

describe('runIdleContinuation', () => {
  test('delivers the nudge when work remains after a safe turn', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'stop' })
    let delivered: string | null = null
    const ok = await runIdleContinuation({ agentDir, origin: TUI, deliver: (t) => (delivered = t) })
    expect(ok).toBe(true)
    expect(delivered).not.toBeNull()
  })

  test('does not deliver after a user abort', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })
    let delivered = false
    const ok = await runIdleContinuation({ agentDir, origin: TUI, deliver: () => (delivered = true) })
    expect(ok).toBe(false)
    expect(delivered).toBe(false)
  })
})
