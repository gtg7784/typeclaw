import { renewCurrentAccount, type AttemptLoginFn } from '@/secrets/kakao-renewal'
import { createKeyStore, type KeyStore } from '@/secrets/keys'

import { keysDir } from './paths'

const DEFAULT_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000

export type KakaoRenewalCallbacks = {
  start: (input: KakaoRenewalStartInput) => void
  stop: (containerName: string) => Promise<void>
}

export type KakaoRenewalStartInput = {
  containerName: string
  cwd: string
}

export type KakaoRenewalLogEvent =
  | { kind: 'kakao-renewal-tick-start'; containerName: string }
  | { kind: 'kakao-renewal-tick-skipped'; containerName: string; reason: string; ageMs?: number }
  | { kind: 'kakao-renewal-tick-ok'; containerName: string; accountId: string; previousUpdatedAt: string }
  | {
      kind: 'kakao-renewal-tick-reauth-required'
      containerName: string
      accountId: string
      reason: string
      message: string
    }
  | { kind: 'kakao-renewal-tick-transient-failure'; containerName: string; accountId: string; reason: string }
  | { kind: 'kakao-renewal-tick-error'; containerName: string; error: string }

export type KakaoRenewalManagerOptions = {
  onLog?: (event: KakaoRenewalLogEvent) => void
  tickIntervalMs?: number
  // Test seam: replace the keystore factory (e.g. point at a tmpdir).
  keyStoreFactory?: () => KeyStore
  // Test seam: replace the upstream login call. Production resolves it
  // lazily from agent-messenger inside renewCurrentAccount.
  attemptLogin?: AttemptLoginFn
  // Test seam: control timer scheduling. Production uses setInterval; tests
  // inject deterministic schedulers so they can fire ticks without real time.
  schedule?: (fn: () => void, intervalMs: number) => { stop: () => void }
}

// Per-container daily renewal tick. Mirrors portbroker-manager.ts: hostd calls
// start() on register and stop() on deregister, and the manager owns timer
// lifecycle plus the actual renewal work. The keystore lives on the host
// (~/.typeclaw/keys/<name>.key), unreachable from inside the container —
// that's load-bearing for encryption.ts's threat model.
export function createKakaoRenewalManager(opts: KakaoRenewalManagerOptions = {}): KakaoRenewalCallbacks & {
  drain: () => Promise<void>
} {
  const intervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const keyStore = (opts.keyStoreFactory ?? (() => createKeyStore({ keysDir: keysDir() })))()
  const log = opts.onLog ?? (() => {})
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms)
      return { stop: () => clearInterval(handle) }
    })

  const timers = new Map<string, { stop: () => void }>()
  const inFlight = new Set<string>()

  const tick = async (input: KakaoRenewalStartInput): Promise<void> => {
    if (inFlight.has(input.containerName)) return
    inFlight.add(input.containerName)
    log({ kind: 'kakao-renewal-tick-start', containerName: input.containerName })
    try {
      const result = await renewCurrentAccount({
        containerName: input.containerName,
        agentDir: input.cwd,
        keyStore,
        ...(opts.attemptLogin ? { attemptLogin: opts.attemptLogin } : {}),
      })
      if (result.kind === 'skipped') {
        log({
          kind: 'kakao-renewal-tick-skipped',
          containerName: input.containerName,
          reason: result.reason,
          ...(result.ageMs !== undefined ? { ageMs: result.ageMs } : {}),
        })
      } else if (result.kind === 'ok') {
        log({
          kind: 'kakao-renewal-tick-ok',
          containerName: input.containerName,
          accountId: result.account_id,
          previousUpdatedAt: result.previousUpdatedAt,
        })
      } else if (result.kind === 'reauth_required') {
        log({
          kind: 'kakao-renewal-tick-reauth-required',
          containerName: input.containerName,
          accountId: result.account_id,
          reason: result.reason,
          message: result.message,
        })
      } else {
        log({
          kind: 'kakao-renewal-tick-transient-failure',
          containerName: input.containerName,
          accountId: result.account_id,
          reason: result.reason,
        })
      }
    } catch (err) {
      // Defensive: renewCurrentAccount's contract is to return a structured
      // result, but a malformed secrets.json or a disk error could surface
      // here. Log and move on — the next tick retries.
      log({
        kind: 'kakao-renewal-tick-error',
        containerName: input.containerName,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      inFlight.delete(input.containerName)
    }
  }

  return {
    start(input: KakaoRenewalStartInput): void {
      const existing = timers.get(input.containerName)
      if (existing) existing.stop()
      const handle = schedule(() => {
        void tick(input)
      }, intervalMs)
      timers.set(input.containerName, handle)
      // First tick runs immediately so a freshly-registered agent doesn't
      // wait a full interval before its first renewal check. Subsequent
      // ticks come from the timer.
      void tick(input)
    },

    async stop(containerName: string): Promise<void> {
      const handle = timers.get(containerName)
      if (!handle) return
      timers.delete(containerName)
      handle.stop()
    },

    async drain(): Promise<void> {
      for (const [, handle] of timers) handle.stop()
      timers.clear()
    },
  }
}
