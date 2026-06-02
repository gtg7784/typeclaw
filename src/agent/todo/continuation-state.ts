import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type ContinuationState,
  emptyContinuationState,
  parseContinuationState,
  type TurnOutcome,
} from './continuation-policy'
import type { TodoScope } from './scope'
import { todoDir } from './store'

type StateFile = {
  version: 1
  state: ContinuationState
}

export function continuationStatePath(agentDir: string, scope: TodoScope): string {
  return join(todoDir(agentDir), '.state', `${scope.key}.json`)
}

export async function readContinuationState(agentDir: string, scope: TodoScope): Promise<ContinuationState> {
  const path = continuationStatePath(agentDir, scope)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return emptyContinuationState()
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateFile>
    return parseContinuationState(parsed.state)
  } catch {
    return emptyContinuationState()
  }
}

export async function writeContinuationState(
  agentDir: string,
  scope: TodoScope,
  state: ContinuationState,
): Promise<void> {
  const path = continuationStatePath(agentDir, scope)
  const payload: StateFile = { version: 1, state }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

// A real user turn ends any active continuation episode and clears both
// suppressors. This is the ONLY thing that resets the episode budget — the
// runtime's own injected continuation prompts must not. Callers pass `false`
// for injected prompts so the episode budget keeps counting down.
export function onTurnStart(state: ContinuationState, isRealUserTurn: boolean): ContinuationState {
  if (!isRealUserTurn) return state
  return {
    ...state,
    episode: null,
    autoResumeBlockedUntilRealUserTurn: false,
    suppressNextIdleNudgeReason: null,
  }
}

// Record the most recently completed turn's outcome. Explicit user abort also
// arms the durable suppressor so no auto-continuation fires until a real user
// turn clears it (policy D1).
export function onTurnOutcome(state: ContinuationState, outcome: TurnOutcome): ContinuationState {
  const next: ContinuationState = { ...state, lastTurnOutcome: outcome }
  if (outcome.stopReason === 'aborted') next.autoResumeBlockedUntilRealUserTurn = true
  return next
}

export function armRestartKickSuppression(state: ContinuationState): ContinuationState {
  return { ...state, suppressNextIdleNudgeReason: 'restart-kick' }
}

export function consumeRestartKickSuppression(state: ContinuationState): ContinuationState {
  if (state.suppressNextIdleNudgeReason === null) return state
  return { ...state, suppressNextIdleNudgeReason: null }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}
