import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { installCodexFetchObserver } from './codex-fetch-observer'

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
    // Tests can mutate globalThis.fetch; reset to the platform default each
    // time so a misbehaving test doesn't leak into the next.
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
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

  test('double install warns and returns existing uninstall', () => {
    const { logger, entries } = captureLogger()
    const uninstall1 = installCodexFetchObserver({ logger })
    const wrappedAfterFirst = globalThis.fetch
    const uninstall2 = installCodexFetchObserver({ logger })
    try {
      expect(globalThis.fetch).toBe(wrappedAfterFirst)
      const warns = entries.filter((e) => e.level === 'warn')
      expect(warns.length).toBe(1)
      expect(warns[0]!.msg).toContain('[codex-fetch]')
      expect(warns[0]!.msg).toContain('already installed')
    } finally {
      uninstall1()
      uninstall2()
    }
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
})
