import { createHash } from 'node:crypto'

import { incompleteTodos, type Todo } from './store'

export const DEFAULT_MAX_AUTO_TURNS = 3
export const DEFAULT_MAX_CUMULATIVE_TOKENS = 25_000
export const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60_000
export const DEFAULT_STAGNATION_LIMIT = 2

export type ContinuationLimits = {
  maxAutoTurns: number
  maxCumulativeTokens: number
  maxWallClockMs: number
  stagnationLimit: number
}

export const DEFAULT_CONTINUATION_LIMITS: ContinuationLimits = {
  maxAutoTurns: DEFAULT_MAX_AUTO_TURNS,
  maxCumulativeTokens: DEFAULT_MAX_CUMULATIVE_TOKENS,
  maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
  stagnationLimit: DEFAULT_STAGNATION_LIMIT,
}

// A continuation episode is the unit a budget applies to. It opens when the
// first auto-nudge fires after a real user turn (or restart recovery) and
// resets only on the next REAL user prompt — never on the runtime's own
// injected prompts. Persisting it lets the budgets survive a restart so a
// crash-loop cannot reset the ceiling.
export type ContinuationEpisode = {
  episodeId: string
  startedAt: number
  autoTurnCount: number
  cumulativeTokens: number
  failureCount: number
  stagnationCount: number
  lastIncompleteHash: string | null
}

// The outcome of the most recently completed turn, recorded from the
// `message_end` subscription (authoritative) or a prompt `finally` fallback.
// `stopReason: 'unknown'` is the fail-closed value: an idle that sees it does
// not auto-inject.
export type TurnOutcome = {
  turnId: string
  stopReason: 'stop' | 'aborted' | 'error' | 'unknown'
  endedAt: number
}

export type ContinuationState = {
  episode: ContinuationEpisode | null
  lastTurnOutcome: TurnOutcome | null
  // One-shot suppressor: the restart kick prompt owns the first post-restart
  // idle, so the first idle after a restart consumes this and skips exactly
  // one injection.
  suppressNextIdleNudgeReason: 'restart-kick' | null
  // Durable user-abort suppressor (policy D1). Set when a turn ends via
  // explicit user abort; cleared only by the next real user turn. While set,
  // no auto-continuation fires regardless of episode budget.
  autoResumeBlockedUntilRealUserTurn: boolean
}

export function emptyContinuationState(): ContinuationState {
  return {
    episode: null,
    lastTurnOutcome: null,
    suppressNextIdleNudgeReason: null,
    autoResumeBlockedUntilRealUserTurn: false,
  }
}

// Canonical hash of the INCOMPLETE todos only. Normalization (sort by id or
// normalized text, collapse whitespace, include status) makes the hash stable
// under reordering and cosmetic edits so it is a usable stagnation heuristic.
// It is deliberately NOT used as proof of progress — see hasRealProgress.
export function hashIncomplete(todos: readonly Todo[]): string {
  const incomplete = incompleteTodos(todos)
  const canonical = incomplete
    .map((t) => ({
      id: t.id ?? '',
      status: t.status,
      content: t.content.trim().replace(/\s+/g, ' '),
    }))
    .sort((a, b) => {
      const ka = a.id !== '' ? a.id : a.content
      const kb = b.id !== '' ? b.id : b.content
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// "Real progress" is stricter than "the hash changed": the incomplete set must
// shrink. Text churn (reword/reorder/split) does not count, which is what
// closes the fake-progress loophole. Only a drop in the number of incomplete
// items resets the stagnation counter.
export function hasRealProgress(prev: readonly Todo[], next: readonly Todo[]): boolean {
  return incompleteTodos(next).length < incompleteTodos(prev).length
}

export type ContinuationDecision =
  | { kind: 'inject'; episode: ContinuationEpisode }
  | { kind: 'skip'; reason: ContinuationSkipReason }

export type ContinuationSkipReason =
  | 'no-incomplete-todos'
  | 'restart-kick-suppressed'
  | 'user-abort-blocked'
  | 'turn-not-safe'
  | 'max-auto-turns'
  | 'max-tokens'
  | 'max-wall-clock'
  | 'stagnation'

// Pure decision: given the current persisted state, the current todos, the
// last turn outcome, a fresh episode-id factory, and `now`, decide whether to
// inject a continuation and return the episode to persist. The caller is
// responsible for persisting `episode` from an `inject` result before actually
// injecting. Fails closed on every ambiguity.
export function decideContinuation(args: {
  state: ContinuationState
  todos: readonly Todo[]
  limits: ContinuationLimits
  now: number
  newEpisodeId: () => string
}): ContinuationDecision {
  const { state, todos, limits, now } = args

  if (incompleteTodos(todos).length === 0) return { kind: 'skip', reason: 'no-incomplete-todos' }

  if (state.suppressNextIdleNudgeReason === 'restart-kick') {
    return { kind: 'skip', reason: 'restart-kick-suppressed' }
  }

  if (state.autoResumeBlockedUntilRealUserTurn) return { kind: 'skip', reason: 'user-abort-blocked' }

  const outcome = state.lastTurnOutcome
  if (outcome === null || outcome.stopReason === 'unknown' || outcome.stopReason === 'aborted') {
    return { kind: 'skip', reason: 'turn-not-safe' }
  }

  const hash = hashIncomplete(todos)
  const episode: ContinuationEpisode = state.episode ?? {
    episodeId: args.newEpisodeId(),
    startedAt: now,
    autoTurnCount: 0,
    cumulativeTokens: 0,
    failureCount: 0,
    stagnationCount: 0,
    lastIncompleteHash: null,
  }

  if (episode.autoTurnCount >= limits.maxAutoTurns) return { kind: 'skip', reason: 'max-auto-turns' }
  if (episode.cumulativeTokens >= limits.maxCumulativeTokens) return { kind: 'skip', reason: 'max-tokens' }
  if (now - episode.startedAt >= limits.maxWallClockMs) return { kind: 'skip', reason: 'max-wall-clock' }

  const stagnated = episode.lastIncompleteHash === hash
  const stagnationCount = stagnated ? episode.stagnationCount + 1 : episode.stagnationCount
  if (stagnationCount >= limits.stagnationLimit) return { kind: 'skip', reason: 'stagnation' }

  return {
    kind: 'inject',
    episode: {
      ...episode,
      autoTurnCount: episode.autoTurnCount + 1,
      stagnationCount,
      lastIncompleteHash: hash,
    },
  }
}
