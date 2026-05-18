import type { AgentSession } from './index'

// pi-coding-agent encodes upstream LLM failures (billing, rate limit, network,
// malformed response, etc.) in the assistant message itself rather than
// throwing — `stopReason: 'error'` with a populated `errorMessage`. Code that
// only catches throws around `session.prompt()` therefore never sees these:
// the prompt resolves normally, no text deltas were emitted, and the only
// signal is the final `message_end` event. Channels, cron, and subagents all
// have to subscribe to surface these soft errors.
//
// Hard throws (timeouts, network drops, etc.) come out of the upstream wrapper
// as exceptions and are handled by the surrounding try/catch in each caller —
// not by this helper.

export type DetectedProviderError = {
  message: string
}

export function detectProviderError(message: unknown): DetectedProviderError | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
  if (m.role !== 'assistant') return null
  // 'aborted' is fired when the user hits Escape — not a provider failure,
  // and the TUI shows its own abort feedback elsewhere. Channels/cron just
  // ignore aborts (no surface to render them on).
  if (m.stopReason !== 'error') return null
  const text = typeof m.errorMessage === 'string' && m.errorMessage.length > 0 ? m.errorMessage : 'LLM call failed'
  return { message: text }
}

export type ProviderErrorListener = (error: DetectedProviderError) => void
export type Unsubscribe = () => void

// Subscribes to `message_end` events on `session` and invokes `onError` once
// per detected provider error. Returns the unsubscribe handle from the
// underlying `session.subscribe`. Callers MUST unsubscribe when the session
// is disposed to avoid leaks across sessions.
export function subscribeProviderErrors(session: AgentSession, onError: ProviderErrorListener): Unsubscribe {
  return session.subscribe((event) => {
    if (event.type !== 'message_end') return
    const detected = detectProviderError(event.message)
    if (detected !== null) onError(detected)
  })
}
