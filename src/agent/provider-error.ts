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
  // Raw provider text. Safe for logs and operator-only surfaces (TUI,
  // `typeclaw logs`), but NOT for channels — see `safeMessage`.
  message: string
  // Redacted, user-facing variant for public/multi-user channels. Known-safe
  // operational classes (rate/usage limit, billing/quota) map to a canonical
  // sentence; everything else (malformed-response SDK dumps, unknown failures)
  // collapses to a generic notice so provider response bodies, URLs, or tokens
  // can never leak to a channel.
  safeMessage: string
}

const GENERIC_SAFE_NOTICE = 'The upstream LLM provider failed. Operators can check `typeclaw logs` for details.'

// Each entry pairs a narrow matcher against the raw provider text with the
// canonical, leak-free sentence shown in channels. Matchers are intentionally
// specific: a miss falls through to GENERIC_SAFE_NOTICE rather than echoing raw
// text, so adding a new class is opt-in and never widens what we expose.
const SAFE_CLASSES: ReadonlyArray<{ match: RegExp; safe: string }> = [
  {
    match: /\b(usage limit|rate limit|rate.?limited|too many requests|429)\b/i,
    safe: 'The upstream LLM provider is rate-limited (usage limit reached). Try again shortly.',
  },
  {
    match: /\b(billing|quota|insufficient.*(credit|fund|balance)|payment|account is not active)\b/i,
    safe: 'The upstream LLM provider rejected the request for a billing/quota reason. Operators can check `typeclaw logs` for details.',
  },
]

function toSafeMessage(raw: string): string {
  for (const { match, safe } of SAFE_CLASSES) {
    if (match.test(raw)) return safe
  }
  return GENERIC_SAFE_NOTICE
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
  return { message: text, safeMessage: toSafeMessage(text) }
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
