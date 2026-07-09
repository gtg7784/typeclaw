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

// The fetch observer (`llm-fetch-observer`) aborts a stalled provider stream
// with a message ending in this marker (TTFB / idle / overall deadline). Such a
// stall is a hard throw, not a `stopReason: 'error'` soft error, so it never
// reaches `detectProviderError`; the marker lets the hard-throw path recognize
// and surface it. The literal is the system's own token — English by design.
const OBSERVER_TIMEOUT = /\(typeclaw observer timeout\)/i

// Transport-layer failure: the request died at the connection/session before a
// usable response — an expired live session, a WebSocket upgrade that never
// reached `101 Switching Protocols`, or a dropped transport. Unlike an
// account-wide auth/billing fault, this is transient AND ref-specific: a
// different ref opens its own session, so failing OVER can succeed. Observed from
// Codex/ChatGPT (`provider_transport_failure`, expired ChatGPT session, a
// `wss://…/codex/responses` non-101 upgrade). Provider protocol tokens — English
// by design (the system-token exception to the multi-language rule).
const TRANSPORT_FAILURE =
  /provider[_ -]?transport[_ -]?failure|(?:websocket|ws) connection.*failed|expected 101|session expired/i

// Auth failure: the provider rejected our credentials (bad/expired/missing API
// key, 401, failed authentication). Account-wide — a different ref shares the
// same credential problem — so this is BOTH a redacted safe-message class (a
// 401 body can carry a Bearer token) AND a NON_FAILOVER_FAULT reason. Shared as
// one constant so the two uses can never drift: previously the safe-message copy
// matched `api key ... expired` but the failover copy didn't, letting
// `session expired: api key expired` wrongly fail over past the auth guard.
const AUTH_FAULT =
  /\b(401|unauthori[sz]ed|invalid[_ -]?api[_ -]?key|api key.*(?:invalid|expired|missing)|authentication failed|invalid bearer)\b/i

// Each entry pairs a narrow matcher against the raw provider text with the
// canonical, leak-free sentence shown in channels. Matchers are intentionally
// specific: a miss falls through to GENERIC_SAFE_NOTICE rather than echoing raw
// text, so adding a new class is opt-in and never widens what we expose.
const SAFE_CLASSES: ReadonlyArray<{ match: RegExp; safe: string }> = [
  {
    // Matched first because a 401 body can also mention "account", which would
    // otherwise fall into the billing class below.
    match: AUTH_FAULT,
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
  {
    match: OBSERVER_TIMEOUT,
    safe: 'The upstream LLM provider stopped responding and the request timed out. Try again shortly.',
  },
  {
    match: TRANSPORT_FAILURE,
    safe: 'The connection to the upstream LLM provider dropped (session/transport failure). Try again shortly.',
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
// status code alone must not force a pointless failover. The auth arm reuses the
// shared `AUTH_FAULT` source so it stays in lockstep with the safe-message class.
const NON_FAILOVER_FAULT = new RegExp(
  `\\bcyber_policy\\b|insufficient.*(?:quota|credit|fund|balance)|\\bquota\\b|billing|payment|account is not active|${AUTH_FAULT.source}`,
  'i',
)

export function isThrottleOrOverload(raw: string): boolean {
  if (NON_FAILOVER_FAULT.test(raw)) return false
  return THROTTLE_OR_OVERLOAD.test(raw)
}

// Failover predicate for turn-drivers' `shouldFailover`: rotate to the next model
// ref on a transient capacity signal (throttle/overload), an observer stall
// timeout, or a transport/session failure. A stall or a dropped session is as
// transient as an overload and another ref (its own session/transport) may well
// succeed, so it must fail OVER before the caller surfaces a failure notice.
// Account-wide faults (billing/quota/auth) are excluded up front — a different
// ref shares the same account problem, so switching can't help.
export function isFailoverWorthy(raw: string): boolean {
  if (NON_FAILOVER_FAULT.test(raw)) return false
  return isThrottleOrOverload(raw) || OBSERVER_TIMEOUT.test(raw) || TRANSPORT_FAILURE.test(raw)
}

// Transient network / upstream 5xx signals that a same-model replay may clear.
// Distinct from THROTTLE_OR_OVERLOAD (429/503/overload) on purpose: an overload
// means the model is out of capacity NOW, so the right move is to fail OVER to a
// different ref, not hammer the same one — whereas a socket hang-up or a 500 is a
// one-off blip a replay against the SAME ref often fixes. `\b` anchors the 5xx
// codes so they don't match digit runs in prose. Provider protocol tokens —
// English by design (the system-token exception to the multi-language rule).
const NETWORK_OR_5XX =
  /econnreset|econnrefused|etimedout|enetunreach|socket hang up|network.?error|connection.?(?:error|refused|reset|lost)|fetch failed|other side closed|reset before headers|http2 request did not get a response|\b(?:500|502|504)\b/i

// Retry predicate for typeclaw-owned SAME-REF retry: replay the SAME model ref
// before advancing the chain. Deliberately NARROWER than `isFailoverWorthy` —
// only transient failures a same-model replay can plausibly clear: transport/
// session drops, observer stalls, and network/5xx blips. It intentionally EXCLUDES
// throttle/overload (429/503) — those mean "this ref is out of capacity now", so
// they should fail OVER to another ref rather than burn same-ref retries — and
// account-wide faults (auth/billing/quota/cyber_policy), which must surface. It
// does NOT match context-overflow: that stays on the SDK compaction path and must
// never be treated as a retryable provider failure.
export function isRetryableSameRef(raw: string): boolean {
  if (NON_FAILOVER_FAULT.test(raw)) return false
  if (isThrottleOrOverload(raw)) return false
  return TRANSPORT_FAILURE.test(raw) || OBSERVER_TIMEOUT.test(raw) || NETWORK_OR_5XX.test(raw)
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

// Classifies a HARD-thrown error (an exception out of `session.prompt()`, after
// model fallback is exhausted) into a user-facing notice — the throw counterpart
// to `detectProviderError`'s soft-error path. Returns `null` for errors that are
// NOT an operator-actionable provider failure (internal bugs, network blips),
// so the caller stays silent-with-log rather than spamming channels. The three
// recognized classes are: failover-worthy throttle/overload, account-wide faults
// (billing/quota/auth) that must surface, and observer stall timeouts.
export function detectHardProviderError(err: unknown): DetectedProviderError | null {
  const message = err instanceof Error ? err.message : String(err)
  const isProviderFailure =
    isThrottleOrOverload(message) ||
    NON_FAILOVER_FAULT.test(message) ||
    OBSERVER_TIMEOUT.test(message) ||
    TRANSPORT_FAILURE.test(message)
  if (!isProviderFailure) return null
  return { message, safeMessage: toSafeMessage(message) }
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
