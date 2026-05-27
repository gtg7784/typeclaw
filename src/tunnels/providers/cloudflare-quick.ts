import type { Unsubscribe } from '@/stream'

import { createLogRing, type LogLineSubscriber, type LogRing } from '../log-ring'
import { extractQuickTunnelUrl } from '../quick-url-parser'
import type { TunnelConfig, TunnelProviderHandle, TunnelState } from '../types'

const DEFAULT_BINARY = 'cloudflared'
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 10_000, 30_000]
const DEFAULT_MAX_FAILURES_WITHOUT_URL = 10
const DEFAULT_STOP_GRACE_MS = 5_000
// cloudflared prints the trycloudflare.com URL to stderr the moment the
// quick-tunnel control connection comes up, but the ephemeral subdomain
// can take 1–3 minutes to propagate through DNS resolvers (see
// cloudflared docs: "it may take some time to be reachable"). If we
// publish the URL before the edge is reachable, any caller that
// registers it with an external service (notably GitHub webhook
// registration → immediate `ping`) loses the first request with
// "failed to connect to host".
//
// Strategy: probe the URL in the background, but ALWAYS emit it once
// either (a) the probe succeeds, or (b) the fallback deadline expires.
// Fail-open by design — a flaky probe must never gate registration
// entirely. Falling back to pre-probe behavior in the worst case is
// strictly better than silently never emitting at all.
const DEFAULT_PROBE_INITIAL_BACKOFF_MS = 250
const DEFAULT_PROBE_MAX_BACKOFF_MS = 5_000
const DEFAULT_PROBE_FETCH_TIMEOUT_MS = 5_000
const DEFAULT_PROBE_DEADLINE_MS = 180_000

export type CloudflareQuickProviderLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

export type CloudflareQuickProviderOptions = {
  config: TunnelConfig
  upstreamPort: number
  onUrlChange: (url: string) => void
  binary?: string
  restartBackoffMs?: number[]
  maxConsecutiveFailuresWithoutUrl?: number
  stopGraceMs?: number
  // Probes the public URL until the Cloudflare edge is actually serving
  // traffic. Returns `true` once any response is observed (including
  // 4xx/5xx — those still mean the tunnel hostname routed). The provider
  // calls this in a retry loop until success or `probeDeadlineMs`.
  // Defaults to a real `fetch`; tests inject a stub.
  probeReady?: (url: string, signal: AbortSignal) => Promise<boolean>
  // Hard deadline after URL parse, after which we emit the URL anyway
  // (with a warning log). 3 minutes by default — covers the slowest
  // observed quick-tunnel DNS propagation. Must be long enough that
  // genuinely working tunnels always pass; short enough that broken
  // tunnels still surface to the caller.
  probeDeadlineMs?: number
  probeInitialBackoffMs?: number
  probeMaxBackoffMs?: number
  logger?: CloudflareQuickProviderLogger
}

export type CloudflareQuickProviderHandle = TunnelProviderHandle & {
  tail: () => string[]
  subscribeToLogs: (cb: LogLineSubscriber) => Unsubscribe
}

const silentLogger: CloudflareQuickProviderLogger = { info: () => {}, warn: () => {} }

export function createCloudflareQuickProvider(options: CloudflareQuickProviderOptions): CloudflareQuickProviderHandle {
  const { config, upstreamPort, onUrlChange } = options
  if (config.provider !== 'cloudflare-quick') {
    throw new Error(`createCloudflareQuickProvider: provider must be 'cloudflare-quick', got '${config.provider}'`)
  }
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error(`tunnel '${config.name}' (cloudflare-quick): upstreamPort must be a valid TCP port`)
  }

  const binary = options.binary ?? DEFAULT_BINARY
  const restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
  const maxConsecutiveFailuresWithoutUrl = options.maxConsecutiveFailuresWithoutUrl ?? DEFAULT_MAX_FAILURES_WITHOUT_URL
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const probeDeadlineMs = options.probeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS
  const probeInitialBackoffMs = options.probeInitialBackoffMs ?? DEFAULT_PROBE_INITIAL_BACKOFF_MS
  const probeMaxBackoffMs = options.probeMaxBackoffMs ?? DEFAULT_PROBE_MAX_BACKOFF_MS
  const probeReady = options.probeReady ?? defaultProbeReady
  const logger = options.logger ?? silentLogger
  const logPrefix = `[tunnels] ${config.name}`
  const logs = createLogRing()
  const state: TunnelState = {
    name: config.name,
    provider: 'cloudflare-quick',
    for: config.for,
    url: null,
    status: 'stopped',
    lastUrlAt: null,
    detail: '',
  }

  let started = false
  let stopping = false
  let proc: ReturnType<typeof Bun.spawn> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let restartFailuresWithoutUrl = 0
  let probeAbort: AbortController | null = null

  async function launch(): Promise<void> {
    if (!started || stopping) return

    state.status = 'starting'
    state.detail = 'starting cloudflared'
    const spawned = Bun.spawn(
      [binary, 'tunnel', '--url', `http://127.0.0.1:${upstreamPort}`, '--no-autoupdate', '--metrics', '127.0.0.1:0'],
      { stdout: 'ignore', stderr: 'pipe' },
    )
    proc = spawned

    void pumpStderr(spawned.stderr, logs, (line) => {
      const url = extractQuickTunnelUrl(line)
      if (url === null) return
      if (state.url === url) return
      void handleUrlEmission(url, spawned)
    })

    void spawned.exited.then((code) => {
      if (proc !== spawned) return
      proc = null
      if (!started || stopping) return
      handleExit(code)
    })
  }

  async function handleUrlEmission(url: string, owningProc: ReturnType<typeof Bun.spawn>): Promise<void> {
    cancelProbe()
    const abort = new AbortController()
    probeAbort = abort
    const startedAt = Date.now()

    logger.info(
      `${logPrefix}: cloudflared printed URL ${url}; probing for edge reachability (deadline ${probeDeadlineMs}ms)`,
    )
    state.status = 'starting'
    state.detail = `probing tunnel readiness (deadline ${probeDeadlineMs}ms)`

    const ready = await probeWithDeadline(url, abort.signal, probeReady, {
      deadlineMs: probeDeadlineMs,
      initialBackoffMs: probeInitialBackoffMs,
      maxBackoffMs: probeMaxBackoffMs,
    })
    if (probeAbort !== abort) return
    probeAbort = null
    if (!started || stopping) return
    if (proc !== owningProc) return

    const elapsedMs = Date.now() - startedAt
    if (ready) {
      logger.info(`${logPrefix}: edge reachable after ${elapsedMs}ms`)
      state.detail = `quick tunnel URL reachable after ${elapsedMs}ms`
    } else {
      logger.warn(
        `${logPrefix}: edge probe did not succeed within ${elapsedMs}ms; emitting URL anyway. First webhook delivery may fail if DNS hasn't propagated yet.`,
      )
      state.detail = `quick tunnel URL emitted without probe confirmation after ${elapsedMs}ms`
    }
    restartFailuresWithoutUrl = 0
    state.url = url
    state.status = 'healthy'
    state.lastUrlAt = Date.now()
    onUrlChange(url)
  }

  function cancelProbe(): void {
    if (probeAbort !== null) {
      probeAbort.abort()
      probeAbort = null
    }
  }

  function handleExit(code: number): void {
    if (state.url === null) restartFailuresWithoutUrl += 1
    if (restartFailuresWithoutUrl >= maxConsecutiveFailuresWithoutUrl) {
      state.status = 'permanently-failed'
      state.detail = `cloudflared exited ${code}; retry cap reached before URL emission`
      return
    }

    state.status = 'unhealthy'
    state.detail = `cloudflared exited ${code}; restarting`
    state.url = null
    const delay = restartBackoffMs[Math.min(restartFailuresWithoutUrl - 1, restartBackoffMs.length - 1)] ?? 30_000
    retryTimer = setTimeout(() => {
      retryTimer = null
      void launch()
    }, delay)
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      stopping = false
      restartFailuresWithoutUrl = 0
      await launch()
    },
    async stop(): Promise<void> {
      if (!started && proc === null) return
      started = false
      stopping = true
      cancelProbe()
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }

      const running = proc
      proc = null
      if (running !== null) {
        running.kill('SIGTERM')
        await Promise.race([
          running.exited,
          sleep(stopGraceMs).then(() => {
            running.kill('SIGKILL')
            return running.exited
          }),
        ])
      }

      stopping = false
      state.status = 'stopped'
      state.detail = ''
    },
    snapshot(): TunnelState {
      return { ...state }
    },
    tail(): string[] {
      return logs.snapshot()
    },
    subscribeToLogs(cb: LogLineSubscriber): Unsubscribe {
      return logs.subscribe(cb)
    },
  }
}

async function pumpStderr(
  stream: ReadableStream<Uint8Array> | null,
  logs: LogRing,
  onLine: (line: string) => void,
): Promise<void> {
  if (stream === null) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let newlineIndex = buffered.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex).replace(/\r$/, '')
        logs.append(line)
        onLine(line)
        buffered = buffered.slice(newlineIndex + 1)
        newlineIndex = buffered.indexOf('\n')
      }
    }
    buffered += decoder.decode()
    if (buffered !== '') {
      const line = buffered.replace(/\r$/, '')
      logs.append(line)
      onLine(line)
    }
  } finally {
    reader.releaseLock()
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

type ProbeDeadlineOptions = {
  deadlineMs: number
  initialBackoffMs: number
  maxBackoffMs: number
}

async function probeWithDeadline(
  url: string,
  signal: AbortSignal,
  probe: (url: string, signal: AbortSignal) => Promise<boolean>,
  opts: ProbeDeadlineOptions,
): Promise<boolean> {
  const deadline = Date.now() + opts.deadlineMs
  let backoff = opts.initialBackoffMs
  while (!signal.aborted && Date.now() < deadline) {
    try {
      if (await probe(url, signal)) return true
    } catch {
      // Probe threw (DNS NXDOMAIN, connection refused, abort, etc.) —
      // treat as not-ready and back off. These errors are expected
      // during the propagation window for a fresh quick tunnel.
    }
    if (signal.aborted) return false
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await sleep(Math.min(backoff, remaining), signal)
    backoff = Math.min(backoff * 2, opts.maxBackoffMs)
  }
  return false
}

async function defaultProbeReady(url: string, signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(DEFAULT_PROBE_FETCH_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  // Any response from the Cloudflare edge — including 404/405/502/530
  // from the unbound or wrong-method upstream — means the tunnel
  // hostname is live and routing. We only care about edge reachability,
  // not upstream health. HEAD is the cheapest verb; redirect:'manual'
  // keeps us from following 301s into unrelated hosts.
  await fetch(url, { method: 'HEAD', redirect: 'manual', signal: combined })
  return true
}
