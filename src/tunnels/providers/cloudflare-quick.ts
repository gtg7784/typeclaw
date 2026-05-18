import type { Unsubscribe } from '@/stream'

import { createLogRing, type LogLineSubscriber, type LogRing } from '../log-ring'
import { extractQuickTunnelUrl } from '../quick-url-parser'
import type { TunnelConfig, TunnelProviderHandle, TunnelState } from '../types'

const DEFAULT_BINARY = 'cloudflared'
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 10_000, 30_000]
const DEFAULT_MAX_FAILURES_WITHOUT_URL = 10
const DEFAULT_STOP_GRACE_MS = 5_000

export type CloudflareQuickProviderOptions = {
  config: TunnelConfig
  upstreamPort: number
  onUrlChange: (url: string) => void
  binary?: string
  restartBackoffMs?: number[]
  maxConsecutiveFailuresWithoutUrl?: number
  stopGraceMs?: number
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
      attemptEmittedUrl = true
      restartFailuresWithoutUrl = 0
      state.url = url
      state.status = 'healthy'
      state.lastUrlAt = Date.now()
      state.detail = 'quick tunnel URL emitted'
      onUrlChange(url)
    })

    void spawned.exited.then((code) => {
      if (proc !== spawned) return
      proc = null
      if (!started || stopping) return
      handleExit(code)
    })
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
