// LINE access tokens (`auth_token`) are JWTs with a ~7-day lifetime. The adapter
// schedules a proactive refresh ahead of expiry rather than waiting for the SDK's
// reactive MUST_REFRESH_V3_TOKEN path, which only fires on a live request and
// surfaces a cryptic failure when the token is already fully expired at startup.

// Refresh once the token is within this window of its expiry. The LINE refresh
// token lives ~365 days and rotates on use, so refreshing early is cheap and
// leaves margin for missed timers (container asleep, listener reconnecting).
export const LINE_TOKEN_REFRESH_SKEW_MS = 24 * 60 * 60 * 1000

// Clamp the scheduled timer so a malformed or far-future `exp` can't push the
// next refresh check beyond a day, and a near/past expiry retries promptly
// rather than busy-looping.
const MIN_REFRESH_DELAY_MS = 60 * 1000
const MAX_REFRESH_DELAY_MS = 24 * 60 * 60 * 1000

export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  const payload = parts[1]
  if (payload === undefined || payload === '') return null
  try {
    const json = Buffer.from(base64UrlToBase64(payload), 'base64').toString('utf-8')
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    const exp = (parsed as { exp?: unknown }).exp
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
    return exp * 1000
  } catch {
    return null
  }
}

export function isTokenNearExpiry(token: string, now: number, skewMs = LINE_TOKEN_REFRESH_SKEW_MS): boolean {
  const expMs = decodeJwtExpMs(token)
  // A token we can't decode is treated as needing refresh: better to attempt a
  // (cheap, idempotent) refresh than to sit on an opaque, possibly-dead token.
  if (expMs === null) return true
  return now >= expMs - skewMs
}

export function nextRefreshDelayMs(token: string, now: number, skewMs = LINE_TOKEN_REFRESH_SKEW_MS): number {
  const expMs = decodeJwtExpMs(token)
  if (expMs === null) return MIN_REFRESH_DELAY_MS
  const target = expMs - skewMs
  const delay = target - now
  if (delay <= 0) return MIN_REFRESH_DELAY_MS
  return Math.min(Math.max(delay, MIN_REFRESH_DELAY_MS), MAX_REFRESH_DELAY_MS)
}

function base64UrlToBase64(input: string): string {
  const replaced = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = replaced.length % 4
  return pad === 0 ? replaced : replaced + '='.repeat(4 - pad)
}
