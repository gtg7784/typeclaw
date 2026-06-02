import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ContinuationEpisode,
  type ContinuationState,
  emptyContinuationState,
  type TurnOutcome,
} from './continuation-policy'
import {
  armRestartKickSuppression,
  consumeRestartKickSuppression,
  onTurnOutcome,
  onTurnStart,
  readContinuationState,
  writeContinuationState,
} from './continuation-state'
import type { TodoScope } from './scope'

const SCOPE: TodoScope = { kind: 'tui', key: 'tui' }

const EPISODE: ContinuationEpisode = {
  episodeId: 'e1',
  startedAt: 100,
  autoTurnCount: 2,
  cumulativeTokens: 5000,
  failureCount: 0,
  stagnationCount: 1,
  lastIncompleteHash: 'abc',
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cont-state-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('continuation-state persistence', () => {
  test('reading a non-existent scope returns the empty state', async () => {
    expect(await readContinuationState(agentDir, SCOPE)).toEqual(emptyContinuationState())
  })

  test('write then read round-trips and survives a simulated restart', async () => {
    const state: ContinuationState = {
      episode: EPISODE,
      lastTurnOutcome: { turnId: 't', stopReason: 'stop', endedAt: 1 },
      suppressNextIdleNudgeReason: null,
      autoResumeBlockedUntilRealUserTurn: false,
    }
    await writeContinuationState(agentDir, SCOPE, state)
    expect(await readContinuationState(agentDir, SCOPE)).toEqual(state)
  })

  test('corrupt state file falls back to empty (fail-closed)', async () => {
    await writeContinuationState(agentDir, SCOPE, emptyContinuationState())
    const { writeFile } = await import('node:fs/promises')
    const { continuationStatePath } = await import('./continuation-state')
    await writeFile(continuationStatePath(agentDir, SCOPE), 'not json{{', 'utf8')
    expect(await readContinuationState(agentDir, SCOPE)).toEqual(emptyContinuationState())
  })
})

describe('onTurnStart', () => {
  test('a real user turn resets the episode and clears suppressors', () => {
    const state: ContinuationState = {
      episode: EPISODE,
      lastTurnOutcome: null,
      suppressNextIdleNudgeReason: 'restart-kick',
      autoResumeBlockedUntilRealUserTurn: true,
    }
    const next = onTurnStart(state, true)
    expect(next.episode).toBeNull()
    expect(next.suppressNextIdleNudgeReason).toBeNull()
    expect(next.autoResumeBlockedUntilRealUserTurn).toBe(false)
  })

  test('an injected (non-user) turn does NOT reset the episode budget', () => {
    const state: ContinuationState = { ...emptyContinuationState(), episode: EPISODE }
    expect(onTurnStart(state, false)).toBe(state)
  })
})

describe('onTurnOutcome', () => {
  test('records the outcome', () => {
    const outcome: TurnOutcome = { turnId: 't', stopReason: 'stop', endedAt: 9 }
    expect(onTurnOutcome(emptyContinuationState(), outcome).lastTurnOutcome).toEqual(outcome)
  })

  test('a user abort arms the durable suppressor', () => {
    const outcome: TurnOutcome = { turnId: 't', stopReason: 'aborted', endedAt: 9 }
    const next = onTurnOutcome(emptyContinuationState(), outcome)
    expect(next.autoResumeBlockedUntilRealUserTurn).toBe(true)
  })

  test('a normal stop does not arm the suppressor', () => {
    const outcome: TurnOutcome = { turnId: 't', stopReason: 'stop', endedAt: 9 }
    expect(onTurnOutcome(emptyContinuationState(), outcome).autoResumeBlockedUntilRealUserTurn).toBe(false)
  })
})

describe('restart-kick suppression', () => {
  test('arm then consume is a one-shot', () => {
    const armed = armRestartKickSuppression(emptyContinuationState())
    expect(armed.suppressNextIdleNudgeReason).toBe('restart-kick')
    const consumed = consumeRestartKickSuppression(armed)
    expect(consumed.suppressNextIdleNudgeReason).toBeNull()
  })
})
