export type CodexFetchObserverLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

export type CodexFetchObserverOptions = {
  logger?: CodexFetchObserverLogger
  codexHost?: string
  now?: () => number
  // Override the default pre-headers (TTFB) deadline applied to the outer
  // fetch(). When the codex backend silently holds a request without sending
  // response headers, this is the timer that releases the request so
  // `pi-coding-agent`'s `_isRetryableError` can retry. Default: 15_000 ms.
  //
  // Healthy Codex turns return response headers within ~1s (observed
  // production p50: ~860ms). The first SSE event (`response.created`) is
  // emitted before any model work begins and arrives within ~50ms of
  // headers. Pathological-but-healthy upper bounds: TLS handshake on a cold
  // connection (~2s), prompt-prefill on a cache miss with large input
  // (~3s), Cloudflare PoP routing slowness (~2s) — sum ~7s. 15s is ~2x
  // that, so anything past it is almost certainly the silent-hang failure
  // mode rather than a real request making progress. False-positive cost
  // is one retry (~5s extra); false-negative cost is the full Bun socket
  // deadline (~268s). Aggressive wins.
  ttfbMs?: number
  // Override the sliding inter-chunk idle deadline applied to the SSE body
  // reader. Resets on every chunk; if no bytes arrive within this window the
  // body stream errors. Like the overall deadline, this doubles as a recovery
  // bound: on a silent stall the user waits this long before the retry fires,
  // so it should not exceed the overall ceiling. Default 120_000 ms (was
  // 300_000, which matched `openai/codex`'s Rust CLI but is 5min of dead air
  // before recovery). 120s is loose enough for OpenAI's keepalive-less
  // reasoning pauses (the Responses API sends no SSE heartbeats, so a quiet
  // reasoning window is genuinely byte-silent) while bounded by the overall
  // cap. Set to 0 to disable just this timer.
  idleMs?: number
  // Override the absolute wall-clock ceiling on a single Codex request,
  // measured from fetch start to body completion. Unlike `idleMs`, it does NOT
  // reset on chunk arrival, so it catches a "slow-trickle" stream that emits
  // bytes inside every idle window yet never reaches a terminal SSE event —
  // the failure mode behind issue #394's multi-minute hang (one observed
  // request occupied 901s before Bun's OS socket deadline fired). On expiry the
  // request is aborted with a retryable error, so this also bounds how long a
  // user waits before the retry fires — keeping it low is a UX requirement, not
  // just a safety net. Default 300_000 ms (raised from 120_000): the 120s cap
  // was tuned against a light-turn sample (slowest healthy ~45s, p99 ~30s) and
  // aborted heavy reasoning turns that were still legitimately trickling bytes
  // — PR reviews, the `dreaming` memory consolidation, and long channel threads
  // routinely run a slow-trickle stream past 2min (observed total_ms=120009 with
  // body_bytes>700k on otherwise-progressing turns). Those are NOT the silent
  // hang this timer exists to catch; the sliding `idleMs` (still 120s) already
  // bounds genuine dead air per-chunk, so the wall-clock ceiling only needs to
  // stop a never-terminating stream. 300s caps a real hang at ~5min while giving
  // heavy turns the headroom they need. Set to 0 to disable just this timer.
  overallMs?: number
  // Schedule fn for tests. Receives (delayMs, callback) and returns a handle
  // the wrapper can pass to `clear`. Default: `setTimeout`/`clearTimeout`.
  scheduler?: TimeoutScheduler
}

export type TimeoutScheduler = {
  set: (delayMs: number, cb: () => void) => unknown
  clear: (handle: unknown) => void
}

const DEFAULT_CODEX_HOST = 'chatgpt.com'
const CODEX_PATH_FRAGMENT = '/codex/responses'
const ENV_DISABLE_OBSERVER = 'TYPECLAW_CODEX_FETCH_OBSERVER'
const ENV_DISABLE_TIMEOUTS = 'TYPECLAW_CODEX_TIMEOUTS'
const ENV_TTFB_MS = 'TYPECLAW_CODEX_TTFB_MS'
const ENV_IDLE_MS = 'TYPECLAW_CODEX_IDLE_MS'
const ENV_OVERALL_MS = 'TYPECLAW_CODEX_OVERALL_MS'
const DEFAULT_TTFB_MS = 15_000
const DEFAULT_IDLE_MS = 120_000
const DEFAULT_OVERALL_MS = 300_000
const LOG_PREFIX = '[codex-fetch]'

const defaultScheduler: TimeoutScheduler = {
  set: (delayMs, cb) => setTimeout(cb, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const consoleLogger: CodexFetchObserverLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
}

type InstallState = {
  originalFetch: typeof fetch
  wrapped: typeof fetch
  claimants: number
}

// Ref-counted so multiple agents in one process (compose, tests) share one
// `globalThis.fetch` wrapper: the FIRST install wraps fetch, each later install
// just joins, and `globalThis.fetch` is restored only when the LAST claimant
// releases. A bare singleton would let one agent's release (e.g. a second
// agent's boot-failure cleanup) tear down the observer out from under another
// still-running agent.
let installed: InstallState | null = null

// Returns true when the request is for the Codex Responses endpoint and we
// should attach phase-timing instrumentation. Method check matches the
// pi-ai provider (only POST hits codex/responses); GETs to the same host
// (auth probes, etc.) are deliberately ignored.
function shouldObserve(input: RequestInfo | URL, init: RequestInit | undefined, codexHost: string): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'POST') return false
  let urlString: string
  if (typeof input === 'string') urlString = input
  else if (input instanceof URL) urlString = input.toString()
  else urlString = input.url
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    return false
  }
  if (parsed.hostname !== codexHost) return false
  return parsed.pathname.includes(CODEX_PATH_FRAGMENT)
}

function quote(value: string | null): string {
  if (value === null) return 'null'
  return `"${value.replace(/"/g, '\\"')}"`
}

function formatLine(fields: {
  status: number | null
  headersMs: number | null
  firstByteMs: number | null
  totalMs: number
  bodyBytes: number
  retryAfter: string | null
  requestId: string | null
  error: string | null
  cause: string | null
}): string {
  return [
    LOG_PREFIX,
    `status=${fields.status === null ? 'null' : fields.status}`,
    `headers_ms=${fields.headersMs === null ? 'null' : fields.headersMs}`,
    `first_byte_ms=${fields.firstByteMs === null ? 'null' : fields.firstByteMs}`,
    `total_ms=${fields.totalMs}`,
    `body_bytes=${fields.bodyBytes}`,
    `retry_after=${fields.retryAfter === null ? 'null' : fields.retryAfter}`,
    `request_id=${fields.requestId === null ? 'null' : fields.requestId}`,
    `error=${quote(fields.error)}`,
    `cause=${fields.cause === null ? 'null' : fields.cause}`,
  ].join(' ')
}

function readEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

type BodyTapConfig = {
  idleMs: number
  overallMs: number
  scheduler: TimeoutScheduler
}

function attachBodyTimingTap(
  response: Response,
  start: number,
  headersMs: number,
  status: number,
  retryAfter: string | null,
  requestId: string | null,
  now: () => number,
  logger: CodexFetchObserverLogger,
  config: BodyTapConfig,
): Response {
  if (response.body === null) {
    logger.info(
      formatLine({
        status,
        headersMs,
        firstByteMs: null,
        totalMs: now() - start,
        bodyBytes: 0,
        retryAfter,
        requestId,
        error: null,
        cause: null,
      }),
    )
    return response
  }

  let firstByteMs: number | null = null
  let bodyBytes = 0
  let settled = false
  let cause: string | null = null

  const settle = (error: string | null) => {
    if (settled) return
    settled = true
    logger.info(
      formatLine({
        status,
        headersMs,
        firstByteMs,
        totalMs: now() - start,
        bodyBytes,
        retryAfter,
        requestId,
        error,
        cause,
      }),
    )
  }

  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (firstByteMs === null) firstByteMs = now() - start
      bodyBytes += chunk.byteLength
      controller.enqueue(chunk)
    },
    flush() {
      settle(null)
    },
  })

  const piped = response.body.pipeThrough(tap, { preventCancel: false })

  const idleController = config.idleMs > 0 || config.overallMs > 0 ? new AbortController() : null
  let idleHandle: unknown = null
  const armIdleTimer = () => {
    if (idleController === null || config.idleMs <= 0) return
    if (idleHandle !== null) config.scheduler.clear(idleHandle)
    idleHandle = config.scheduler.set(config.idleMs, () => {
      cause = 'idle_timeout'
      idleController.abort(new Error(`Codex SSE body idle for ${config.idleMs}ms (typeclaw observer timeout)`))
    })
  }

  // Absolute ceiling on the whole request, armed once and never reset. The
  // budget is measured from `start` (before originalFetch), so the time already
  // spent waiting for headers is subtracted here — otherwise a slow-headers
  // request would get a fresh full `overallMs` for its body on top of the
  // headers wait, doubling the intended ceiling. A non-positive remainder means
  // the budget is already spent, so we schedule at 0 to abort on the next tick.
  // Aborts the shared controller so the existing reader race tears the stream
  // down on the first deadline to fire — idle or overall, whichever comes first.
  let overallHandle: unknown = null
  if (idleController !== null && config.overallMs > 0) {
    const remainingOverallMs = Math.max(0, config.overallMs - (now() - start))
    overallHandle = config.scheduler.set(remainingOverallMs, () => {
      cause = 'overall_timeout'
      idleController.abort(
        new Error(`Codex SSE body exceeded overall deadline of ${config.overallMs}ms (typeclaw observer timeout)`),
      )
    })
  }
  const disarmOverallTimer = () => {
    if (overallHandle !== null) {
      config.scheduler.clear(overallHandle)
      overallHandle = null
    }
  }

  const disarmIdleTimer = () => {
    disarmOverallTimer()
    if (idleHandle !== null) {
      config.scheduler.clear(idleHandle)
      idleHandle = null
    }
  }

  // The idle abort listener is installed exactly once for the lifetime of the
  // stream and removed in `finally`. Earlier shapes constructed a fresh
  // `Promise.race` listener per chunk; if `reader.read()` won the race, the
  // listener was never removed and closures accumulated on the signal across a
  // long stream. Keeping one shared abort promise bounds the listener count to
  // 1 regardless of chunk count.
  const observerBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = piped.getReader()
      armIdleTimer()
      let abortFired = false
      let onAbort: (() => void) | null = null
      const abortPromise = idleController
        ? new Promise<never>((_, reject) => {
            onAbort = () => {
              abortFired = true
              reject(idleController.signal.reason ?? new Error('idle timeout'))
            }
            if (idleController.signal.aborted) onAbort()
            else idleController.signal.addEventListener('abort', onAbort, { once: true })
          })
        : null
      // Swallow the shared rejection if no race ever observes it (clean stream
      // end before any timeout). Without this, an aborted-after-close path
      // could surface as an unhandled rejection on the runtime.
      abortPromise?.catch(() => {})
      try {
        while (true) {
          const readPromise = reader.read()
          const result = abortPromise ? await Promise.race([readPromise, abortPromise]) : await readPromise
          if (abortFired) {
            reader.cancel(idleController!.signal.reason).catch(() => {})
            throw idleController!.signal.reason
          }
          const { done, value } = result
          if (done) {
            disarmIdleTimer()
            controller.close()
            return
          }
          armIdleTimer()
          controller.enqueue(value)
        }
      } catch (err) {
        disarmIdleTimer()
        const message = err instanceof Error ? err.message : String(err)
        settle(message)
        controller.error(err)
      } finally {
        if (onAbort !== null && idleController !== null && !idleController.signal.aborted) {
          idleController.signal.removeEventListener('abort', onAbort)
        }
        reader.releaseLock()
      }
    },
    cancel(reason) {
      disarmIdleTimer()
      const message = reason === undefined ? 'cancelled' : reason instanceof Error ? reason.message : String(reason)
      settle(message)
    },
  })

  return new Response(observerBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function installCodexFetchObserver(opts: CodexFetchObserverOptions = {}): () => void {
  if (process.env[ENV_DISABLE_OBSERVER] === 'off') {
    return () => {}
  }
  const logger = opts.logger ?? consoleLogger
  if (installed !== null) {
    installed.claimants++
    return makeRelease(installed.wrapped)
  }

  const codexHost = opts.codexHost ?? DEFAULT_CODEX_HOST
  const now = opts.now ?? Date.now
  const scheduler = opts.scheduler ?? defaultScheduler
  const timeoutsEnabled = process.env[ENV_DISABLE_TIMEOUTS] !== 'off'
  const ttfbMs = timeoutsEnabled ? (opts.ttfbMs ?? readEnvMs(ENV_TTFB_MS, DEFAULT_TTFB_MS)) : 0
  const idleMs = timeoutsEnabled ? (opts.idleMs ?? readEnvMs(ENV_IDLE_MS, DEFAULT_IDLE_MS)) : 0
  const overallMs = timeoutsEnabled ? (opts.overallMs ?? readEnvMs(ENV_OVERALL_MS, DEFAULT_OVERALL_MS)) : 0
  const originalFetch = globalThis.fetch

  const wrappedImpl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (!shouldObserve(input, init, codexHost)) {
      return originalFetch(input, init)
    }
    const start = now()

    let ttfbCause: 'ttfb_timeout' | null = null
    let ttfbHandle: unknown = null
    let initWithSignal: RequestInit | undefined = init
    if (ttfbMs > 0) {
      const ttfbController = new AbortController()
      ttfbHandle = scheduler.set(ttfbMs, () => {
        ttfbCause = 'ttfb_timeout'
        ttfbController.abort(
          new Error(`Codex fetch timed out before response headers after ${ttfbMs}ms (typeclaw observer timeout)`),
        )
      })
      const signal = init?.signal ? AbortSignal.any([init.signal, ttfbController.signal]) : ttfbController.signal
      initWithSignal = { ...init, signal }
    }

    let response: Response
    try {
      response = await originalFetch(input, initWithSignal)
    } catch (err) {
      if (ttfbHandle !== null) scheduler.clear(ttfbHandle)
      const isTtfbAbort = ttfbCause === 'ttfb_timeout'
      const surfacedError = isTtfbAbort
        ? new Error(`Codex fetch timed out before response headers after ${ttfbMs}ms (typeclaw observer timeout)`)
        : err
      const message = surfacedError instanceof Error ? surfacedError.message : String(surfacedError)
      logger.info(
        formatLine({
          status: null,
          headersMs: null,
          firstByteMs: null,
          totalMs: now() - start,
          bodyBytes: 0,
          retryAfter: null,
          requestId: null,
          error: message,
          cause: ttfbCause,
        }),
      )
      throw surfacedError
    }
    if (ttfbHandle !== null) scheduler.clear(ttfbHandle)
    const headersMs = now() - start
    const retryAfter = response.headers.get('retry-after')
    const requestId = response.headers.get('x-request-id')
    return attachBodyTimingTap(response, start, headersMs, response.status, retryAfter, requestId, now, logger, {
      idleMs,
      overallMs,
      scheduler,
    })
  }

  // Preserve any static methods Bun attaches to `globalThis.fetch` (e.g.
  // `preconnect`) so the wrapper is a drop-in replacement.
  const wrapped = Object.assign(wrappedImpl, {
    preconnect: (originalFetch as { preconnect?: (url: string) => void }).preconnect ?? (() => {}),
  }) as typeof fetch

  globalThis.fetch = wrapped

  installed = { originalFetch, wrapped, claimants: 1 }
  return makeRelease(wrapped)
}

// Each install call gets its own idempotent release. The shared
// `globalThis.fetch` wrapper is restored only when the final claimant releases,
// so one agent releasing never disturbs another's still-active observer.
function makeRelease(wrapped: typeof fetch): () => void {
  let released = false
  return () => {
    if (released || installed === null || installed.wrapped !== wrapped) return
    released = true
    installed.claimants--
    if (installed.claimants > 0) return
    if (globalThis.fetch === installed.wrapped) {
      globalThis.fetch = installed.originalFetch
    }
    installed = null
  }
}
