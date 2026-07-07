import { renewCurrentAccount } from '@/secrets/teams-renewal'

// Teams skype tokens live only 60-90 minutes (far shorter than Webex's ~27h),
// so the tick is minutes not hours: 5 minutes gives ~3 refresh attempts inside
// the 15-minute renewal window before a token would lapse, while a fresh token
// short-circuits to a cheap no-op skip.
const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000

export type TeamsRenewalCallbacks = {
  start: (input: TeamsRenewalStartInput) => void
  stop: (containerName: string) => Promise<void>
  drain: () => Promise<void>
}

export type TeamsRenewalStartInput = {
  containerName: string
  cwd: string
}

export type TeamsRenewalLogEvent =
  | { kind: 'teams-renewal-tick-start'; containerName: string }
  | { kind: 'teams-renewal-tick-skipped'; containerName: string; reason: string; expiresInMs?: number }
  | { kind: 'teams-renewal-tick-ok'; containerName: string; accountId: string; nextExpiresAt: number }
  | {
      kind: 'teams-renewal-tick-reauth-required'
      containerName: string
      accountId: string
      reason: string
      message: string
    }
  | { kind: 'teams-renewal-tick-transient-failure'; containerName: string; accountId: string; reason: string }
  | { kind: 'teams-renewal-tick-error'; containerName: string; error: string }
  | { kind: 'teams-renewal-restart-scheduled'; containerName: string; accountId: string }
  | { kind: 'teams-renewal-restart-failed'; containerName: string; accountId: string; reason: string }

export type TeamsRenewalManagerOptions = {
  onLog?: (event: TeamsRenewalLogEvent) => void
  tickIntervalMs?: number
  renew?: typeof renewCurrentAccount
  schedule?: (fn: () => void, intervalMs: number) => { stop: () => void }
  // Invoked after a successful renewal so the host can restart the container and
  // the in-memory TeamsClient picks up the fresh token. Without this, the cron
  // writes a new token to secrets.json but the live client keeps the old token
  // in its login closure (src/channels/adapters/teams.ts) and still fails to
  // obtain an id_token for the realtime listener.
  onRenewalOk?: (input: { containerName: string; cwd: string; accountId: string }) => Promise<void>
  // Only start the renewal cron for containers whose typeclaw.json actually has
  // a channels.teams block, so non-teams agents don't emit no_account skip logs.
  shouldRenew?: (input: TeamsRenewalStartInput) => boolean
}

export function createTeamsRenewalManager(opts: TeamsRenewalManagerOptions = {}): TeamsRenewalCallbacks {
  const intervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const renew = opts.renew ?? renewCurrentAccount
  const log = opts.onLog ?? (() => {})
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms)
      return { stop: () => clearInterval(handle) }
    })

  const timers = new Map<string, { stop: () => void }>()
  const latestInput = new Map<string, TeamsRenewalStartInput>()
  const inFlight = new Map<string, Promise<void>>()
  const pendingRerun = new Set<string>()

  const runTick = async (input: TeamsRenewalStartInput): Promise<void> => {
    log({ kind: 'teams-renewal-tick-start', containerName: input.containerName })
    try {
      const result = await renew({ agentDir: input.cwd })
      if (result.kind === 'skipped') {
        log({
          kind: 'teams-renewal-tick-skipped',
          containerName: input.containerName,
          reason: result.reason,
          ...(result.expiresInMs !== undefined ? { expiresInMs: result.expiresInMs } : {}),
        })
      } else if (result.kind === 'ok') {
        log({
          kind: 'teams-renewal-tick-ok',
          containerName: input.containerName,
          accountId: result.account_id,
          nextExpiresAt: result.nextExpiresAt,
        })
        // A tick that started before stop()/drain() or before a re-register with
        // a different cwd can finish here. Restarting a container that is no
        // longer the current registration would resurrect a just-deregistered
        // agent or fight a shutdown, so skip onRenewalOk unless this
        // container+cwd is still the live registration.
        const current = latestInput.get(input.containerName)
        if (opts.onRenewalOk && current?.cwd === input.cwd) {
          log({
            kind: 'teams-renewal-restart-scheduled',
            containerName: input.containerName,
            accountId: result.account_id,
          })
          try {
            await opts.onRenewalOk({
              containerName: input.containerName,
              cwd: input.cwd,
              accountId: result.account_id,
            })
          } catch (err) {
            log({
              kind: 'teams-renewal-restart-failed',
              containerName: input.containerName,
              accountId: result.account_id,
              reason: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } else if (result.kind === 'reauth_required') {
        log({
          kind: 'teams-renewal-tick-reauth-required',
          containerName: input.containerName,
          accountId: result.account_id,
          reason: result.reason,
          message: result.message,
        })
      } else {
        log({
          kind: 'teams-renewal-tick-transient-failure',
          containerName: input.containerName,
          accountId: result.account_id,
          reason: result.reason,
        })
      }
    } catch (err) {
      log({
        kind: 'teams-renewal-tick-error',
        containerName: input.containerName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const scheduleTick = (containerName: string): Promise<void> => {
    const existing = inFlight.get(containerName)
    if (existing) {
      pendingRerun.add(containerName)
      return existing
    }
    const promise = (async () => {
      while (true) {
        const input = latestInput.get(containerName)
        if (!input) return
        await runTick(input)
        if (!pendingRerun.has(containerName)) return
        pendingRerun.delete(containerName)
      }
    })().finally(() => {
      inFlight.delete(containerName)
      pendingRerun.delete(containerName)
    })
    inFlight.set(containerName, promise)
    return promise
  }

  return {
    start(input: TeamsRenewalStartInput): void {
      // Tear down any prior registration BEFORE the shouldRenew gate: the daemon
      // calls start() on every registration, so a container that had Teams can
      // re-register to a non-Teams cwd; returning early without clearing would
      // leave the old timer ticking and let a post-login restart guard match the
      // stale cwd. Clearing latestInput also fails an in-flight tick's
      // onRenewalOk re-check.
      const existing = timers.get(input.containerName)
      if (existing) {
        existing.stop()
        timers.delete(input.containerName)
      }
      latestInput.delete(input.containerName)

      if (opts.shouldRenew && !opts.shouldRenew(input)) return

      latestInput.set(input.containerName, input)
      const handle = schedule(() => {
        void scheduleTick(input.containerName)
      }, intervalMs)
      timers.set(input.containerName, handle)
      void scheduleTick(input.containerName)
    },

    // Must NOT await the in-flight tick: a successful tick runs onRenewalOk →
    // hostdRestart → container stop() → deregister RPC → teamsRenewal.stop(), so
    // awaiting inFlight here waits on the very tick parked waiting for this
    // restart — a self-deadlock. Clearing latestInput (not the await) is what
    // fails the tick's onRenewalOk guard; drain() still awaits.
    stop(containerName: string): Promise<void> {
      const handle = timers.get(containerName)
      if (handle) {
        timers.delete(containerName)
        handle.stop()
      }
      latestInput.delete(containerName)
      return Promise.resolve()
    },

    async drain(): Promise<void> {
      for (const [, handle] of timers) handle.stop()
      timers.clear()
      // Clear latestInput AFTER awaiting in-flight: the onRenewalOk guard reads
      // latestInput, so clearing first would suppress the restart of a tick that
      // is mid-refresh when drain() runs. drain() is shutdown — it waits for
      // that work to finish rather than dropping it.
      const promises = Array.from(inFlight.values())
      await Promise.allSettled(promises)
      latestInput.clear()
    },
  }
}
