import type { AgentSession } from './index'
import { isRetryableSameRef, subscribeProviderErrors } from './provider-error'

// Same-ref retry policy. Conservative on purpose: the pi-ai provider layer ALSO
// retries transport/5xx blips underneath us (WebSocket→SSE fallback + its own
// SSE retry loop), and each typeclaw attempt is bounded by the observer timeouts
// (TTFB 15s / idle 120s / overall 300s). Stacking a large per-ref retry count on
// top of that turns one outage into minutes of dead air, so we replay the same
// ref just ONCE by default and rely on cross-ref fallback for anything the single
// replay can't clear.
export const RETRIES_PER_REF = 1
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 5_000

// Full-jitter exponential backoff: random in [0, min(cap, base·2^attempt)].
// Jitter decorrelates concurrent turns (multiple channels/subagents recovering
// from the same upstream blip) so they don't retry in lockstep and re-collide.
export function retryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// For callers that recreate the session themselves (cron) and only need the delay.
export function sleepBackoff(attempt: number, signal?: AbortSignal, random?: () => number): Promise<void> {
  return sleep(retryBackoffMs(attempt, random), signal)
}

type ContinuableAgent = {
  state?: { messages?: unknown }
  continue?: () => Promise<void>
}

// Replay the CURRENT turn on a persistent session WITHOUT re-appending the user
// message. Mirrors the SDK's own auto-retry shape, resuming via `agent.continue()`
// (which replays from the trailing user/tool-result message). Re-calling
// `session.prompt(text)` instead would duplicate the user message and corrupt
// history, so we never do that.
//
// Two resolved shapes are retryable, matching `continue()`'s contract that the
// last message be user/tool-result:
//   - trailing ASSISTANT error leaf → pop it, then continue (soft error, or a
//     hard throw AFTER a partial assistant message was written)
//   - trailing USER message → the provider died BEFORE writing any assistant
//     message (the reported incident: transport/session failure before stream
//     start). Nothing to pop — continue() replays the user turn as-is.
// Any other trailing shape (tool-result mid-execution, custom, empty transcript,
// no `agent.continue`) fails CLOSED — the caller falls back / surfaces instead.
export async function retryTurnOnPersistentSession(
  session: AgentSession,
  opts: { attempt: number; signal?: AbortSignal; random?: () => number } = { attempt: 0 },
): Promise<boolean> {
  const agent = (session as { agent?: ContinuableAgent }).agent
  if (!agent || typeof agent.continue !== 'function') return false
  const messages = agent.state?.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  const leafRole = (messages[messages.length - 1] as { role?: unknown }).role
  if (leafRole !== 'assistant' && leafRole !== 'user') return false

  await sleep(retryBackoffMs(opts.attempt, opts.random), opts.signal)
  if (opts.signal?.aborted) return false

  // Drop only a trailing assistant error leaf; a trailing user message is already
  // the shape continue() wants, so leave it untouched (and never re-appended).
  if (leafRole === 'assistant') {
    ;(agent.state as { messages: unknown }).messages = messages.slice(0, -1)
  }
  await agent.continue()
  return true
}

// Same-ref retry for DIRECT `session.prompt()` call sites that bypass the model
// fallback helpers (non-stream TUI, slash commands, subagent drain/required-block
// nudges, multimodal look-at). These lost the SDK's built-in retry when it was
// disabled globally to kill the soft-error race; this restores equivalent
// same-model resilience WITHOUT cross-ref fallback (there's no chain here) and
// WITHOUT the race (typeclaw owns the soft-error signal). On a non-retryable
// failure it does exactly what a bare prompt() did: the throw propagates, or the
// soft error stays on the leaf for the caller to read.
export async function promptWithSameRefRetryOnly(
  session: AgentSession,
  text: string,
  promptOpts?: Parameters<AgentSession['prompt']>[1],
): Promise<void> {
  let softError: Error | undefined
  // Feature-detect subscribe: some lightweight call sites / test fakes pass a
  // session without an event stream. Without it we simply can't observe soft
  // errors — the wrapper then only retries hard throws, still safe.
  const canSubscribe = typeof (session as { subscribe?: unknown }).subscribe === 'function'
  const unsub = canSubscribe
    ? subscribeProviderErrors(session, (err) => {
        if (!softError) softError = new Error(err.message)
      })
    : () => {}
  try {
    // Carry the last attempt's failure so a retry that CAN'T run (unsafe
    // transcript shape → retryTurnOnPersistentSession returns false) still
    // surfaces the original failure instead of resolving as a phantom success.
    let priorHardError: Error | undefined
    for (let attempt = 0; ; attempt++) {
      softError = undefined
      let hardError: Error | undefined
      try {
        if (attempt === 0) {
          await session.prompt(text, promptOpts)
        } else if (!(await retryTurnOnPersistentSession(session, { attempt: attempt - 1 }))) {
          // Continue-recipe not applicable: replay never happened, so the prior
          // failure stands — re-throw a hard error, or return to leave a soft
          // error on the leaf (bare-prompt() semantics).
          if (priorHardError !== undefined) throw priorHardError
          return
        }
      } catch (err) {
        hardError = err instanceof Error ? err : new Error(String(err))
      }
      const error = hardError ?? softError
      if (error === undefined) return
      if (attempt >= RETRIES_PER_REF || !isRetryableSameRef(error.message)) {
        // Out of budget or not retryable: preserve bare-prompt() semantics — a
        // hard error throws; a soft error stays on the leaf for the caller.
        if (hardError !== undefined) throw hardError
        return
      }
      priorHardError = hardError
    }
  } finally {
    unsub()
  }
}
