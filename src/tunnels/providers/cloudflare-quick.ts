import type { Unsubscribe } from '@/stream'

import { createLogRing, type LogLineSubscriber, type LogRing } from '../log-ring'
import { extractQuickTunnelUrl } from '../quick-url-parser'
import type { TunnelConfig, TunnelProviderHandle, TunnelState } from '../types'

const DEFAULT_BINARY = 'cloudflared'
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 10_000, 30_000]
const DEFAULT_MAX_FAILURES_WITHOUT_URL = 10
const DEFAULT_STOP_GRACE_MS = 5_000
// cloudflared prints the trycloudflare.com URL to stderr the moment the
// quick-tunnel control connection is established, but the Cloudflare edge
// does not start accepting HTTPS for that hostname until ~hundreds of ms
// to a few seconds later. If we publish the URL the instant it's parsed,
// any caller that registers the URL with an external service (notably
// GitHub webhook registration → immediate `ping`) loses the first request
// with "failed to connect to host". We probe the URL ourselves until the
// edge responds, then emit. Budget is generous enough to absorb a slow
// edge propagation but bounded so a genuinely broken tunnel still hits
// the restart cap via `handleExit`.
const DEFAULT_PROBE_BACKOFF_MS = [250, 500, 1_000, 1_000, 2_000, 2_000, 3_000, 5_000]
const DEFAULT_PROBE_TIMEOUT_MS = 5_000

export type CloudflareQuickProviderOptions = {
  config: TunnelConfig
  upstreamPort: number
  onUrlChange: (url: string) => void
  binary?: string
  restartBackoffMs?: number[]
  maxConsecutiveFailuresWithoutUrl?: number
  stopGraceMs?: number
  // Probes the public URL until the Cloudflare edge is actually serving
  // traffic. Returns `true` once a response is observed (any HTTP status
  // counts — even 404 from the upstream means the tunnel itself routed
  // the request), `false` if the probe budget is exhausted. Defaults to
  // a real `fetch` with retry/backoff; tests inject a stub.
  probeReady?: (url: string, signal: AbortSignal) => Promise<boolean>
  probeBackoffMs?: number[]
}

export type CloudflareQuickProviderHandle = TunnelProviderHandle & {
  tail: () => string[]
  subscribeToLogs: (cb: LogLineSubscriber) => Unsubscribe
}

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
  const probeBackoffMs = options.probeBackoffMs ?? DEFAULT_PROBE_BACKOFF_MS
  const probeReady = options.probeReady ?? defaultProbeReady
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
  let attemptEmittedUrl = false
  let probeAbort: AbortController | null = null

  async function launch(): Promise<void> {
    if (!started || stopping) return

    attemptEmittedUrl = false
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

    state.status = 'starting'
    state.detail = 'probing tunnel readiness'

    const ready = await probeWithBackoff(url, abort.signal, probeReady, probeBackoffMs)
    if (probeAbort !== abort) return
    probeAbort = null
    if (!started || stopping) return
    if (proc !== owningProc) return

    if (!ready) {
      state.detail = 'tunnel URL emitted but probe failed; will restart'
      owningProc.kill('SIGKILL')
      return
    }

    attemptEmittedUrl = true
    restartFailuresWithoutUrl = 0
    state.url = url
    state.status = 'healthy'
    state.lastUrlAt = Date.now()
    state.detail = 'quick tunnel URL emitted and reachable'
    onUrlChange(url)
  }

  function cancelProbe(): void {
    if (probeAbort !== null) {
      probeAbort.abort()
      probeAbort = null
    }
  }

  function handleExit(code: number): void {
    if (!attemptEmittedUrl) restartFailuresWithoutUrl += 1
    if (restartFailuresWithoutUrl >= maxConsecutiveFailuresWithoutUrl) {
      state.status = 'permanently-failed'
      state.detail = `cloudflared exited ${code}; retry cap reached before URL emission`
      return
    }

    state.status = 'unhealthy'
    state.detail = `cloudflared exited ${code}; restarting`
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

async function probeWithBackoff(
  url: string,
  signal: AbortSignal,
  probe: (url: string, signal: AbortSignal) => Promise<boolean>,
  backoffMs: number[],
): Promise<boolean> {
  for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
    if (signal.aborted) return false
    try {
      if (await probe(url, signal)) return true
    } catch {
      // Probe threw (network error, abort, etc.) — treat as not-ready and back off.
    }
    if (signal.aborted) return false
    const delay = backoffMs[attempt]
    if (delay === undefined) return false
    await sleep(delay, signal)
  }
  return false
}

async function defaultProbeReady(url: string, signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  try {
    // Any response from the Cloudflare edge — including 404, 502, etc. from
    // the unbound upstream — means the tunnel hostname is live. We only
    // care about edge reachability, not upstream health.
    await fetch(url, { method: 'HEAD', redirect: 'manual', signal: combined })
    return true
  } catch {
    return false
  }
}
