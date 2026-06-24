// Retry-with-backoff for search-engine calls that hit a transient rate-limit
// or CAPTCHA wall.
//
// Empirically, lite.duckduckgo.com does NOT recover in milliseconds once it
// starts gating: a tripped source IP stays boxed for minutes, and the gate
// surfaces as a CAPTCHA page (parsed as DdgCaptchaError) rather than a clean
// 429. So the backoff here is deliberately generous (seconds, growing) — a
// tight millisecond retry would just burn the remaining budget and confirm the
// box. The concurrency cap (keyed-semaphore.ts) is the real preventer; this is
// the second line of defense for a request that still raced into a gate.
//
// `shouldRetry` decides which errors are worth retrying — only transient
// rate-limit/CAPTCHA signals, never a parse error or a hard network failure.

export type SearchRetryOptions = {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  shouldRetry: (error: unknown) => boolean
  signal?: AbortSignal
  // Injectable sleep so tests can run without real timers.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export const DEFAULT_SEARCH_RETRY_ATTEMPTS = 3
export const DEFAULT_SEARCH_RETRY_BASE_DELAY_MS = 2_000
export const DEFAULT_SEARCH_RETRY_MAX_DELAY_MS = 15_000

export async function withSearchRetry<T>(work: () => Promise<T>, options: SearchRetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_SEARCH_RETRY_ATTEMPTS))
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_SEARCH_RETRY_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_SEARCH_RETRY_MAX_DELAY_MS
  const sleep = options.sleep ?? defaultSleep

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) throw new SearchRetryAbortedError()
    try {
      return await work()
    } catch (error) {
      lastError = error
      const isLastAttempt = attempt === attempts - 1
      if (isLastAttempt || !options.shouldRetry(error)) throw error
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs), options.signal)
    }
  }
  throw lastError
}

export class SearchRetryAbortedError extends Error {
  constructor() {
    super('Search retry aborted.')
    this.name = 'SearchRetryAbortedError'
  }
}

// Exponential backoff with full jitter (AWS "Exponential Backoff And Jitter").
// Full jitter — random in [0, capped] — decorrelates concurrent retriers so a
// burst that all tripped the gate together does not re-collide on the same
// wake-up, which would just re-trip the box.
export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  return Math.floor(Math.random() * capped)
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SearchRetryAbortedError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new SearchRetryAbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
