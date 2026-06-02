import type { SessionOrigin } from '@/agent/session-origin'

import { maybeInjectContinuation } from './continuation'
import { type TurnOutcome } from './continuation-policy'
import { onTurnOutcome, onTurnStart, readContinuationState, writeContinuationState } from './continuation-state'
import { resolveTodoScope } from './scope'

// Map a pi `message_end` event's stopReason onto the TurnOutcome stopReason
// space. Anything we don't recognize collapses to 'unknown' so the idle path
// fails closed (no auto-injection on an outcome we can't classify).
export function classifyStopReason(raw: unknown): TurnOutcome['stopReason'] {
  if (raw === 'stop' || raw === 'aborted' || raw === 'error') return raw
  return 'unknown'
}

export function extractStopReason(event: unknown): TurnOutcome['stopReason'] | null {
  if (typeof event !== 'object' || event === null) return null
  const e = event as { type?: unknown; message?: unknown }
  if (e.type !== 'message_end') return null
  const message = e.message as { role?: unknown; stopReason?: unknown } | undefined
  if (message?.role !== 'assistant') return null
  return classifyStopReason(message.stopReason)
}

// Persist the just-completed turn's outcome for a scope. No-op for origins
// without a todo scope (subagent/system). Safe to call from a subscription
// callback; it swallows nothing — callers wrap as they see fit.
export async function recordTurnOutcome(args: {
  agentDir: string
  origin: SessionOrigin
  turnId: string
  stopReason: TurnOutcome['stopReason']
  now?: number
}): Promise<void> {
  const scope = resolveTodoScope(args.origin)
  if (scope === null) return
  const state = await readContinuationState(args.agentDir, scope)
  const outcome: TurnOutcome = { turnId: args.turnId, stopReason: args.stopReason, endedAt: args.now ?? Date.now() }
  await writeContinuationState(args.agentDir, scope, onTurnOutcome(state, outcome))
}

// Reset the continuation episode at the start of a REAL user turn. Injected
// continuation turns pass isRealUserTurn=false so the episode budget keeps
// counting down. No-op for scopeless origins.
export async function recordTurnStart(args: {
  agentDir: string
  origin: SessionOrigin
  isRealUserTurn: boolean
}): Promise<void> {
  const scope = resolveTodoScope(args.origin)
  if (scope === null) return
  const state = await readContinuationState(args.agentDir, scope)
  const next = onTurnStart(state, args.isRealUserTurn)
  if (next !== state) await writeContinuationState(args.agentDir, scope, next)
}

export type DeliverContinuation = (text: string) => void

// Idle-path entry: decide whether to nudge and, if so, deliver via the
// origin-appropriate mechanism the caller supplies. Returns true if a nudge
// was delivered. The decide-and-persist step happens inside
// maybeInjectContinuation; delivery is the only side effect the caller owns.
export async function runIdleContinuation(args: {
  agentDir: string
  origin: SessionOrigin
  deliver: DeliverContinuation
}): Promise<boolean> {
  const result = await maybeInjectContinuation({ agentDir: args.agentDir, origin: args.origin })
  if (result.kind !== 'injected') return false
  args.deliver(result.text)
  return true
}
