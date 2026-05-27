export type CodexFetchObserverLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

export type CodexFetchObserverOptions = {
  logger?: CodexFetchObserverLogger
  codexHost?: string
  now?: () => number
}

const DEFAULT_CODEX_HOST = 'chatgpt.com'
const CODEX_PATH_FRAGMENT = '/codex/responses'
const ENV_DISABLE = 'TYPECLAW_CODEX_FETCH_OBSERVER'
const LOG_PREFIX = '[codex-fetch]'

const consoleLogger: CodexFetchObserverLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
}

type InstallState = {
  originalFetch: typeof fetch
  uninstall: () => void
}

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
  ].join(' ')
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
      }),
    )
    return response
  }

  let firstByteMs: number | null = null
  let bodyBytes = 0
  let settled = false

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

  // We can't observe a `cancel()` on the downstream consumer directly from
  // the TransformStream, but pipeThrough propagates cancellation to the
  // source, which terminates the readable side; the `flush` callback fires
  // on a clean close, and any error surfaces by aborting the piped stream's
  // reader. The consumer-facing stream below adds an explicit cancel hook.
  const observerBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = piped.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          controller.enqueue(value)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        settle(message)
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
    cancel(reason) {
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
  if (process.env[ENV_DISABLE] === 'off') {
    return () => {}
  }
  const logger = opts.logger ?? consoleLogger
  if (installed !== null) {
    logger.warn(`${LOG_PREFIX} install called but observer already installed; ignoring`)
    return installed.uninstall
  }

  const codexHost = opts.codexHost ?? DEFAULT_CODEX_HOST
  const now = opts.now ?? Date.now
  const originalFetch = globalThis.fetch

  const wrappedImpl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (!shouldObserve(input, init, codexHost)) {
      return originalFetch(input, init)
    }
    const start = now()
    let response: Response
    try {
      response = await originalFetch(input, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
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
        }),
      )
      throw err
    }
    const headersMs = now() - start
    const retryAfter = response.headers.get('retry-after')
    const requestId = response.headers.get('x-request-id')
    return attachBodyTimingTap(response, start, headersMs, response.status, retryAfter, requestId, now, logger)
  }

  // Preserve any static methods Bun attaches to `globalThis.fetch` (e.g.
  // `preconnect`) so the wrapper is a drop-in replacement.
  const wrapped = Object.assign(wrappedImpl, {
    preconnect: (originalFetch as { preconnect?: (url: string) => void }).preconnect ?? (() => {}),
  }) as typeof fetch

  globalThis.fetch = wrapped

  const uninstall = () => {
    if (installed === null) return
    if (globalThis.fetch === wrapped) {
      globalThis.fetch = originalFetch
    }
    installed = null
  }

  installed = { originalFetch, uninstall }
  return uninstall
}
