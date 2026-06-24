// Webex's internal conversation API rate-limits reads PER ROOM, not per account:
// hammering one room's history returns HTTP 429 (x-ratelimit-limit ~3, Retry-After
// up to ~25s) while a different room served by the same token stays unaffected
// (verified empirically — saturating room A produced zero 429s on room B). The
// upstream agent-messenger SDK retries 429s, but its bucket tracker is reactive
// (it learns the limit only after a 429 lands) and its 3-retry budget cannot
// outlast a 25s window, so same-room pile-up — cold-start prefetch plus the
// membership resolver's deriveMembershipFromHistory fallback, both reading the
// same room — overflows the bucket and fails the prefetch.
//
// History prefetch is a context improvement, not liveness — the router skips it
// and the agent can call channel_history on demand later. So the fix is keyed by
// room: bound concurrent reads PER ROOM (independent rooms never wait on each
// other) and keep cold-start non-blocking with bounded admission ("admit fast or
// skip"), because starting then abandoning a listMessages we cannot cancel (the
// SDK exposes no AbortSignal) would only burn more quota on an orphaned fetch.

export type WebexPrefetchLimiter = {
  // Runs `work` under the permit pool for `key` (the room id). If no slot frees
  // within `admitTimeoutMs`, resolves to `{ admitted: false }` WITHOUT starting
  // `work` — the caller then skips the prefetch. On admission, runs `work` and
  // returns its result. Distinct keys never contend.
  run<T>(key: string, work: () => Promise<T>): Promise<{ admitted: true; value: T } | { admitted: false }>
}

export type WebexPrefetchLimiterOptions = {
  // Max concurrent reads PER ROOM. Defaults to 2: Webex's per-room cap is ~3, so
  // 2 leaves headroom for the SDK's own retry traffic while still letting a
  // prefetch and a membership-fallback read of the same room overlap.
  concurrency?: number
  // How long a queued caller waits for a slot before giving up and skipping.
  // Defaults to 2500ms, matching the prior cold-fetch fail-fast posture so a
  // backlog never stalls cold-start past the router's history ceiling.
  admitTimeoutMs?: number
}

const DEFAULT_CONCURRENCY = 2
const DEFAULT_ADMIT_TIMEOUT_MS = 2500

export function createWebexPrefetchLimiter(options: WebexPrefetchLimiterOptions = {}): WebexPrefetchLimiter {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))
  const admitTimeoutMs = options.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS

  type Pool = { active: number; waiters: Array<() => void> }
  const pools = new Map<string, Pool>()

  const poolFor = (key: string): Pool => {
    let pool = pools.get(key)
    if (pool === undefined) {
      pool = { active: 0, waiters: [] }
      pools.set(key, pool)
    }
    return pool
  }

  const release = (key: string): void => {
    const pool = pools.get(key)
    if (pool === undefined) return
    pool.active--
    const next = pool.waiters.shift()
    if (next) next()
    // Drop idle pools so a long-lived limiter does not accumulate one entry per
    // room ever seen.
    else if (pool.active === 0 && pool.waiters.length === 0) pools.delete(key)
  }

  const acquire = (key: string): Promise<boolean> => {
    const pool = poolFor(key)
    if (pool.active < concurrency) {
      pool.active++
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const idx = pool.waiters.indexOf(grant)
        if (idx >= 0) pool.waiters.splice(idx, 1)
        resolve(false)
      }, admitTimeoutMs)
      const grant = (): void => {
        if (settled) {
          // Admitted after we already gave up: hand the freed slot to the next
          // waiter so a timed-out grant never leaks a permanently-held slot.
          release(key)
          return
        }
        settled = true
        clearTimeout(timer)
        pool.active++
        resolve(true)
      }
      pool.waiters.push(grant)
    })
  }

  return {
    async run<T>(key: string, work: () => Promise<T>): Promise<{ admitted: true; value: T } | { admitted: false }> {
      const admitted = await acquire(key)
      if (!admitted) return { admitted: false }
      try {
        return { admitted: true, value: await work() }
      } finally {
        release(key)
      }
    },
  }
}

// The SDK throws WebexError with code 'rate_limited' once 429 retries are
// exhausted, and 'http_429' for a raw 429 that bypassed the retry path. Both mean
// the same thing to us: an expected, transient, non-fatal rate-limit skip — not an
// auth/network failure worth a warn. Matching on the SDK's code field (rather than
// the human message) keeps this stable across SDK message-wording changes.
export function isWebexRateLimitError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === 'rate_limited' || code === 'http_429'
}
