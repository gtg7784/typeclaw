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
    // Auth failure: the provider rejected our credentials (bad/expired/missing
    // API key). Matched first because a 401 body can also mention "account",
    // which would otherwise fall into the billing class below. The safe text
    // names the operator action (check the API key) without echoing the raw
    // error, whose body can carry a Bearer token.
    match:
      /\b(401|unauthori[sz]ed|invalid[_ -]?api[_ -]?key|api key.*(?:invalid|expired|missing)|authentication failed|invalid bearer)\b/i,
    safe: 'The upstream LLM provider rejected the request as unauthorized. Operators should check the provider API key configuration and `typeclaw logs`.',
  },
  {
    // Content-policy refusal: OpenAI Codex flags a prompt under its cybersecurity
    // policy (`code: "cyber_policy"`) and rejects the whole turn with
    // `invalid_request`. Retrying or failing over to another Codex ref can't help
    // — it's the same account-wide policy — so this must surface with the operator
    // action (get the account authorized) rather than collapse to the generic
    // notice. Common for security-focused PR reviews, where the diff content trips
    // the filter. The URL is OpenAI's own published enrollment page, safe to echo.
    match: /\bcyber_policy\b/i,
    safe: 'The upstream LLM provider (OpenAI Codex) refused the request under its cybersecurity content policy. Operators must enroll the account in OpenAI Trusted Access for Cyber at https://chatgpt.com/cyber, or switch the configured model.',
  },
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

// Capacity/rate signals worth failing OVER to another model ref (vs. retrying
// the same one). English-only is correct — these are provider protocol tokens,
// the explicit system-token exception to the multi-language rule. `\b` anchors
// `429`/`503` so they don't match digit runs in prose (token counts,
// elapsed-ms); `\b` is ASCII-safe because these are ASCII-only codes.
const THROTTLE_OR_OVERLOAD =
  /overloaded|server_is_overloaded|service.?unavailable|rate.?limit|rate.?limited|too many requests|\b(?:429|503)\b/i

// Account-wide faults that must SURFACE, never fail over: switching refs can't
// help (same account) and would mask a config error the operator must fix. This
// is checked BEFORE the throttle match because providers often pair a `429`
// status with a quota/billing/auth reason (e.g. `429 insufficient quota`) — the
// status code alone must not force a pointless failover.
const NON_FAILOVER_FAULT =
  /\bcyber_policy\b|insufficient.*(?:quota|credit|fund|balance)|\bquota\b|billing|payment|account is not active|unauthori[sz]ed|invalid[_ -]?api[_ -]?key|authentication failed|invalid bearer/i

export function isThrottleOrOverload(raw: string): boolean {
  if (NON_FAILOVER_FAULT.test(raw)) return false
  return THROTTLE_OR_OVERLOAD.test(raw)
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
    if (detected === null) return
    const abortRetry = (session as { abortRetry?: unknown }).abortRetry
    if (isThrottleOrOverload(detected.message) && typeof abortRetry === 'function') abortRetry.call(session)
    onError(detected)
  })
}
