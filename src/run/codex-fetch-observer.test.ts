import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { installCodexFetchObserver, type TimeoutScheduler } from './codex-fetch-observer'

// Programmable scheduler for tests. Tasks scheduled for time T fire when the
// test calls `fire(T)`. Out-of-order T values (T must be monotonically
// non-decreasing across calls) are not supported; tests advance time forward.
function makeScheduler(): TimeoutScheduler & { fire: (t: number) => Promise<void>; pending: () => number } {
  type Entry = { id: number; dueAt: number; cb: () => void; cancelled: boolean }
  let counter = 0
  let nowMs = 0
  const entries: Entry[] = []
  return {
    set: (delayMs, cb) => {
      const e: Entry = { id: ++counter, dueAt: nowMs + delayMs, cb, cancelled: false }
      entries.push(e)
      return e
    },
    clear: (handle) => {
      const e = handle as Entry
      e.cancelled = true
    },
    fire: async (t) => {
      nowMs = t
      const flush = () => new Promise<void>((r) => queueMicrotask(r))
      while (true) {
        const due = entries.find((e) => !e.cancelled && e.dueAt <= t)
        if (!due) break
        due.cancelled = true
        due.cb()
        await flush()
        await flush()
      }
    },
    pending: () => entries.filter((e) => !e.cancelled).length,
  }
}

type LogEntry = { level: 'info' | 'warn'; msg: string }

function captureLogger(): { logger: { info: (m: string) => void; warn: (m: string) => void }; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    logger: {
      info: (m) => entries.push({ level: 'info', msg: m }),
      warn: (m) => entries.push({ level: 'warn', msg: m }),
    },
  }
}

// Programmable clock so phase timings are deterministic. `now()` returns
// whatever the test most recently set; production reads timings via the
// `now` option, so we never depend on real wall-clock in assertions.
function makeClock() {
  let ms = 0
  return {
    now: () => ms,
    set: (v: number) => {
      ms = v
    },
  }
}

// Body controller pair: lets the test push chunks/close/error into a Response
// body at the moments it chooses, after walking the clock to the right value.
// More predictable than a self-scheduling fake because each event awaits a
// microtask flush before the next test step assertion.
function makeControllableBody(): {
  body: ReadableStream<Uint8Array>
  push: (data: Uint8Array) => Promise<void>
  close: () => Promise<void>
  error: (err: Error) => Promise<void>
} {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  let resolveReady!: (c: ReadableStreamDefaultController<Uint8Array>) => void
  const ready = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => {
    resolveReady = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      resolveReady(controller)
    },
  })
  const flush = () => new Promise<void>((r) => queueMicrotask(r))
  return {
    body,
    push: async (data) => {
      const c = controllerRef ?? (await ready)
      c.enqueue(data)
      await flush()
      await flush()
    },
    close: async () => {
      const c = controllerRef ?? (await ready)
      c.close()
      await flush()
    },
    error: async (err) => {
      const c = controllerRef ?? (await ready)
      c.error(err)
      await flush()
    },
  }
}

// Drain a readable stream to completion, ignoring chunks. Lets us trigger the
// observer's final log without caring about what the SSE consumer would do.
async function drainQuiet(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (stream === null) return
  const reader = stream.getReader()
  try {
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  } catch {
    // expected for error-stream tests
  }
}

const originalFetch = globalThis.fetch

describe('installCodexFetchObserver', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.TYPECLAW_CODEX_TIMEOUTS
    delete process.env.TYPECLAW_CODEX_TTFB_MS
    delete process.env.TYPECLAW_CODEX_IDLE_MS
    delete process.env.TYPECLAW_CODEX_OVERALL_MS
    delete process.env.TYPECLAW_CODEX_FETCH_OBSERVER
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.TYPECLAW_CODEX_TIMEOUTS
    delete process.env.TYPECLAW_CODEX_TTFB_MS
    delete process.env.TYPECLAW_CODEX_IDLE_MS
    delete process.env.TYPECLAW_CODEX_OVERALL_MS
    delete process.env.TYPECLAW_CODEX_FETCH_OBSERVER
  })

  test('passes non-Codex requests through unchanged (no wrapping)', async () => {
    const { logger, entries } = captureLogger()
    const sentinel = Symbol('upstream')
    globalThis.fetch = (async () => sentinel as unknown as Response) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger })
    try {
      const result = await fetch('https://example.com/some/other/path')
      expect(result).toBe(sentinel as unknown as Response)
      expect(entries).toEqual([])
    } finally {
      uninstall()
    }
  })

  test('propagates errors from non-Codex upstream verbatim', async () => {
    const { logger, entries } = captureLogger()
    const upstreamError = new Error('upstream boom')
    globalThis.fetch = (async () => {
      throw upstreamError
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger })
    try {
      await expect(fetch('https://api.openai.com/v1/responses')).rejects.toBe(upstreamError)
      expect(entries).toEqual([])
    } finally {
      uninstall()
    }
  })

  test('logs phase timings for a Codex request', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(50)
      return new Response(ctrl.body, {
        status: 200,
        headers: { 'x-request-id': 'req_abc123', 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      const responsePromise = fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const response = await responsePromise
      expect(response.status).toBe(200)
      const drainPromise = drainQuiet(response.body)
      clock.set(200)
      await ctrl.push(new TextEncoder().encode('data: {"type":"response.created"}\n\n'))
      clock.set(1500)
      await ctrl.push(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'))
      clock.set(2000)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    const line = codexLines[0]!.msg
    expect(line).toContain('status=200')
    expect(line).toContain('headers_ms=50')
    expect(line).toContain('first_byte_ms=200')
    expect(line).toContain('total_ms=2000')
    expect(line).toContain('request_id=req_abc123')
    expect(line).toContain('retry_after=null')
    expect(line).toContain('error=null')
  })

  test('logs retry_after header when present (throttling signal)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(10)
      return new Response(ctrl.body, {
        status: 429,
        headers: { 'retry-after': '42', 'x-request-id': 'req_throttled' },
      })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(20)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    expect(codexLines[0]!.msg).toContain('status=429')
    expect(codexLines[0]!.msg).toContain('retry_after=42')
  })

  test('logs stream errors with error message and partial timings', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(30)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(100)
      await ctrl.push(new TextEncoder().encode('data: hi\n\n'))
      clock.set(300)
      await ctrl.error(new Error('connection reset by peer'))
      await drainPromise
    } finally {
      uninstall()
    }

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    const line = codexLines[0]!.msg
    expect(line).toContain('status=200')
    expect(line).toContain('first_byte_ms=100')
    expect(line).toContain('error="connection reset by peer"')
  })

  test('logs fetch() rejection (pre-response error)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    globalThis.fetch = (async () => {
      clock.set(500)
      throw new Error('fetch failed')
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      await expect(fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })).rejects.toThrow(
        'fetch failed',
      )
    } finally {
      uninstall()
    }

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    expect(codexLines[0]!.msg).toContain('error="fetch failed"')
    expect(codexLines[0]!.msg).toContain('headers_ms=null')
    expect(codexLines[0]!.msg).toContain('first_byte_ms=null')
    expect(codexLines[0]!.msg).toMatch(/total_ms=\d+/)
  })

  test('matches Codex URL by host and path, ignores other paths on same host', async () => {
    const { logger, entries } = captureLogger()
    const sentinel = new Response(null, { status: 204 })
    globalThis.fetch = (async () => sentinel) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger })
    try {
      const result = await fetch('https://chatgpt.com/backend-api/me')
      expect(result).toBe(sentinel)
      expect(entries.filter((e) => e.msg.startsWith('[codex-fetch]'))).toEqual([])
    } finally {
      uninstall()
    }
  })

  test('uninstall restores original fetch', () => {
    const { logger } = captureLogger()
    const before = globalThis.fetch
    const uninstall = installCodexFetchObserver({ logger })
    expect(globalThis.fetch).not.toBe(before)
    uninstall()
    expect(globalThis.fetch).toBe(before)
  })

  test('a second install shares the wrapper and is ref-counted: a later release keeps fetch observed while another claimant remains', () => {
    const { logger } = captureLogger()
    const before = globalThis.fetch
    const release1 = installCodexFetchObserver({ logger })
    const wrappedAfterFirst = globalThis.fetch
    const release2 = installCodexFetchObserver({ logger })
    try {
      // given two claimants sharing one wrapper
      expect(globalThis.fetch).toBe(wrappedAfterFirst)

      // when the second claimant releases (e.g. a second agent's boot-failure
      // cleanup), the first agent's observer must survive
      release2()
      expect(globalThis.fetch).toBe(wrappedAfterFirst)

      // then only the final release restores the original fetch
      release1()
      expect(globalThis.fetch).toBe(before)
    } finally {
      release1()
      release2()
    }
  })

  test('a release is idempotent and never tears down a re-acquired observer', () => {
    const { logger } = captureLogger()
    const before = globalThis.fetch
    const release1 = installCodexFetchObserver({ logger })
    release1()
    release1() // idempotent: second call is a no-op
    expect(globalThis.fetch).toBe(before)

    // a fresh install after full release re-wraps and is independent
    const release2 = installCodexFetchObserver({ logger })
    expect(globalThis.fetch).not.toBe(before)
    // the stale release1 must NOT restore over the new observer
    release1()
    expect(globalThis.fetch).not.toBe(before)
    release2()
    expect(globalThis.fetch).toBe(before)
  })

  test('TYPECLAW_CODEX_FETCH_OBSERVER=off disables installation', () => {
    const { logger, entries } = captureLogger()
    const before = globalThis.fetch
    process.env.TYPECLAW_CODEX_FETCH_OBSERVER = 'off'
    try {
      const uninstall = installCodexFetchObserver({ logger })
      expect(globalThis.fetch).toBe(before)
      uninstall()
      expect(globalThis.fetch).toBe(before)
      expect(entries.filter((e) => e.msg.startsWith('[codex-fetch]'))).toEqual([])
    } finally {
      delete process.env.TYPECLAW_CODEX_FETCH_OBSERVER
    }
  })

  test('custom codexHost option matches a different host (for staging/testing)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, codexHost: 'staging.example.com', now: clock.now })
    try {
      clock.set(0)
      const response = await fetch('https://staging.example.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(20)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    expect(entries.filter((e) => e.msg.startsWith('[codex-fetch]')).length).toBe(1)
  })

  test('TTFB timeout aborts pending fetch with a retryable error message', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    let underlyingSignal: AbortSignal | undefined
    let fetchRejection: Promise<never> | null = null
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      fetchRejection = new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      })
      return fetchRejection as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 50, idleMs: 0 })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      clock.set(50)
      await scheduler.fire(50)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('timed out')
    expect(caught!.message).toContain('15ms'.replace('15', '50'))
    expect(underlyingSignal?.aborted).toBe(true)

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    const line = codexLines[0]!.msg
    expect(line).toContain('status=null')
    expect(line).toContain('headers_ms=null')
    expect(line).toContain('first_byte_ms=null')
    expect(line).toContain('total_ms=50')
    expect(line).toContain('cause=ttfb_timeout')
    expect(line).toMatch(/error="Codex fetch timed out before response headers after 50ms.*"/)
  })

  test('TTFB timer is cancelled once headers arrive (healthy fast turn)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(10)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 1000, idleMs: 0 })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(50)
      await ctrl.push(new TextEncoder().encode('hi'))
      clock.set(100)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    expect(scheduler.pending()).toBe(0)
    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    expect(codexLines[0]!.msg).toContain('status=200')
    expect(codexLines[0]!.msg).toContain('cause=null')
    expect(codexLines[0]!.msg).toContain('error=null')
  })

  test('TTFB composes with caller-provided AbortSignal (caller abort still wins)', async () => {
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    const callerController = new AbortController()
    let underlyingSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 60000, idleMs: 0 })
    let caught: Error | null = null
    try {
      const pending = fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        signal: callerController.signal,
      })
      callerController.abort(new Error('user pressed escape'))
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    expect(caught).not.toBeNull()
    expect(caught!.message).toBe('user pressed escape')
    expect(underlyingSignal?.aborted).toBe(true)
  })

  test('Idle timeout aborts body reader when no chunks arrive within the window', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 100 })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(105)
      await scheduler.fire(105)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('idle for 100ms')

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    const line = codexLines[0]!.msg
    expect(line).toContain('status=200')
    expect(line).toContain('cause=idle_timeout')
    expect(line).toMatch(/error=".*idle for 100ms.*"/)
  })

  test('Idle timer resets on every chunk', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 100 })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(80)
      await ctrl.push(new TextEncoder().encode('chunk1'))
      clock.set(160)
      await ctrl.push(new TextEncoder().encode('chunk2'))
      clock.set(240)
      await ctrl.push(new TextEncoder().encode('chunk3'))
      clock.set(300)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    expect(codexLines[0]!.msg).toContain('cause=null')
    expect(codexLines[0]!.msg).toContain('error=null')
    expect(codexLines[0]!.msg).toContain('body_bytes=18')
  })

  test('Overall deadline aborts a slow-trickle stream that never trips the idle timer', async () => {
    // Reproduces typeclaw issue #394's slow-trickle hang: the body keeps
    // emitting bytes inside the inter-chunk idle window (so the sliding idle
    // timer re-arms forever) but never reaches a terminal SSE event. With only
    // TTFB + idle timers, such a stream occupies the turn until Bun's OS socket
    // deadline fires (~900s observed in production). The overall deadline is the
    // absolute wall-clock ceiling that catches exactly this class.
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    // idleMs=100 (small) but each chunk lands inside it, so idle never trips.
    // overallMs=250 is exceeded while chunks are still trickling.
    const uninstall = installCodexFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 100,
      overallMs: 250,
    })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      // Trickle chunks every 80ms — always inside the 100ms idle window, so the
      // idle timer keeps resetting and would never fire on its own.
      clock.set(80)
      await ctrl.push(new TextEncoder().encode('chunk1'))
      clock.set(160)
      await ctrl.push(new TextEncoder().encode('chunk2'))
      clock.set(240)
      await ctrl.push(new TextEncoder().encode('chunk3'))
      // Cross the overall deadline (250ms from request start) before the next chunk.
      clock.set(260)
      await scheduler.fire(260)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('overall deadline')

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    const line = codexLines[0]!.msg
    expect(line).toContain('status=200')
    expect(line).toContain('cause=overall_timeout')
    expect(line).toMatch(/error=".*overall deadline.*"/)
  })

  test('Overall deadline counts time spent waiting for headers (measured from fetch start)', async () => {
    // The ceiling is "from fetch start to body completion", so a slow-headers
    // request must NOT receive a fresh full overallMs for its body. Headers
    // arrive at t=200 with overallMs=250, leaving only 50ms of body budget — the
    // body must abort at t=250, not at t=450 (which a body-only timer would give).
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(200)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 0,
      overallMs: 250,
    })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(250)
      await scheduler.fire(250)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('overall deadline')
    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines[0]!.msg).toContain('cause=overall_timeout')
  })

  test('Overall deadline aborts immediately when the budget is already spent on headers', async () => {
    // Headers arrive at t=300 with overallMs=250 — the budget is exhausted
    // before the body starts. The remainder clamps to 0, so the body aborts on
    // the very next tick rather than getting any additional time.
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(300)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 0,
      overallMs: 250,
    })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(300)
      await scheduler.fire(300)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('overall deadline')
    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines[0]!.msg).toContain('cause=overall_timeout')
  })

  test('Idle abort listener count stays bounded across many chunks (no leak)', async () => {
    // given: a stream that will emit 100 chunks with a long idle window. The
    // pre-fix shape called `idleController.signal.addEventListener('abort', …)`
    // inside the per-iteration `Promise.race`, leaking one closure per chunk
    // when `reader.read()` won. The fix shares one listener across the whole
    // stream, so listener installations across N chunks must stay at <= 1.
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    const RealAbortController = globalThis.AbortController
    let installedAbortListeners = 0
    class CountingAbortController extends RealAbortController {
      constructor() {
        super()
        const realAdd = this.signal.addEventListener.bind(this.signal)
        this.signal.addEventListener = ((
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: AddEventListenerOptions | boolean,
        ) => {
          if (type === 'abort') installedAbortListeners += 1
          return realAdd(type, listener, options)
        }) as typeof this.signal.addEventListener
      }
    }
    globalThis.AbortController = CountingAbortController as unknown as typeof AbortController

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 10_000 })
    try {
      // when: 100 chunks flow through, each one comfortably inside the idle window
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      const chunk = new TextEncoder().encode('x')
      for (let i = 0; i < 100; i++) {
        clock.set(10 + i)
        await ctrl.push(chunk)
      }
      clock.set(200)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
      globalThis.AbortController = RealAbortController
    }

    // then: only the single shared listener should ever be installed across
    // the full lifetime of the stream, regardless of chunk count
    expect(installedAbortListeners).toBeLessThanOrEqual(1)
  })

  test('TYPECLAW_CODEX_TIMEOUTS=off disables timeouts but keeps observer active', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    process.env.TYPECLAW_CODEX_TIMEOUTS = 'off'
    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 50, idleMs: 50 })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(10000)
      await ctrl.push(new TextEncoder().encode('x'))
      clock.set(20000)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    expect(scheduler.pending()).toBe(0)
    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines.length).toBe(1)
    expect(codexLines[0]!.msg).toContain('status=200')
    expect(codexLines[0]!.msg).toContain('cause=null')
  })

  test('TYPECLAW_CODEX_TTFB_MS env var overrides default', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    process.env.TYPECLAW_CODEX_TTFB_MS = '250'
    let underlyingSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, idleMs: 0 })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      clock.set(250)
      await scheduler.fire(250)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('250ms')

    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines[0]!.msg).toContain('total_ms=250')
    expect(codexLines[0]!.msg).toContain('cause=ttfb_timeout')
  })

  test('Overall deadline fires even when the idle timer is disabled', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 0,
      overallMs: 200,
    })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(210)
      await scheduler.fire(210)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('overall deadline')
    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines[0]!.msg).toContain('cause=overall_timeout')
  })

  test('overallMs=0 disables the overall deadline (stream may run unbounded)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 0,
      overallMs: 0,
    })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(1_000_000)
      await ctrl.push(new TextEncoder().encode('late'))
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    expect(scheduler.pending()).toBe(0)
    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines[0]!.msg).toContain('cause=null')
    expect(codexLines[0]!.msg).toContain('error=null')
  })

  test('TYPECLAW_CODEX_OVERALL_MS env var overrides default', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    process.env.TYPECLAW_CODEX_OVERALL_MS = '300'
    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installCodexFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 0 })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(305)
      await scheduler.fire(305)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('300ms')
    const codexLines = entries.filter((e) => e.msg.startsWith('[codex-fetch]'))
    expect(codexLines[0]!.msg).toContain('cause=overall_timeout')
  })
})
