// A process-wide keyed concurrency limiter: at most `concurrency` calls run
// at once PER KEY, and work queued behind a full key WAITS for a slot rather
// than being skipped. Distinct keys never contend.
//
// This is the queue-and-wait sibling of src/channels/adapters/webex-prefetch-
// limiter.ts. That limiter uses admit-or-skip because its work (history
// prefetch) is an optional context improvement — dropping it is fine. Here the
// work is a search the model explicitly asked for, so dropping it is NOT fine;
// callers must block until a slot frees.
//
// Why this exists: one typeclaw agent is one process, and all sessions
// (TUI, channel, cron, subagent) share that process. A search engine like
// DuckDuckGo rate-limits by source IP, and the whole agent egresses from one
// IP, so parallel searches across sessions/subagents stack onto the same
// per-engine budget. An empirical probe of lite.duckduckgo.com showed a clean
// IP serves ~4 concurrent requests but trips a sticky multi-minute CAPTCHA at
// 5-6 — and once tripped, even serial requests stay boxed. Capping concurrency
// PER ENGINE keeps the burst under that ceiling so the box is never tripped.

export type KeyedSemaphore = {
  // Runs `work` once a slot for `key` is free, waiting if necessary. The slot
  // is released when `work` settles (resolve or reject). Distinct keys run
  // fully independently. If `signal` aborts while the call is still queued (or
  // is already aborted on entry), the call rejects with SemaphoreAbortedError
  // WITHOUT ever running `work` or holding a slot.
  run<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

export type KeyedSemaphoreOptions = {
  // Max concurrent runs PER KEY. Defaults to 1.
  concurrency?: number
}

export class SemaphoreAbortedError extends Error {
  constructor() {
    super('Semaphore acquisition aborted before admission.')
    this.name = 'SemaphoreAbortedError'
  }
}

export function createKeyedSemaphore(options: KeyedSemaphoreOptions = {}): KeyedSemaphore {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))

  type Waiter = () => void
  type Pool = { active: number; waiters: Waiter[] }
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
    if (next) {
      pool.active++
      next()
      // Drop idle pools so a long-lived semaphore does not accumulate one entry
      // per key ever seen.
    } else if (pool.active === 0 && pool.waiters.length === 0) {
      pools.delete(key)
    }
  }

  const acquire = (key: string, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new SemaphoreAbortedError())
    const pool = poolFor(key)
    if (pool.active < concurrency) {
      pool.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const grant: Waiter = () => {
        if (settled) {
          // Granted after we already aborted: hand the freed slot to the next
          // waiter so an aborted grant never leaks a permanently-held slot.
          release(key)
          return
        }
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        const idx = pool.waiters.indexOf(grant)
        if (idx >= 0) pool.waiters.splice(idx, 1)
        reject(new SemaphoreAbortedError())
      }
      pool.waiters.push(grant)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    async run<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(key, signal)
      try {
        return await work()
      } finally {
        release(key)
      }
    },
  }
}
