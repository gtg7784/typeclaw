import { defineCommand } from 'citty'

import { loadConfigSync, validateConfig, type Config, type ValidateConfigResult } from '@/config'
import { start, stop, type StartOptions, type StartResult, type StopResult } from '@/container'
import { startDaemon, type DaemonLogEvent, type RestartPreflight } from '@/hostd/daemon'
import { createKakaoRenewalManager } from '@/hostd/kakao-renewal-manager'
import { createPortbrokerManager } from '@/hostd/portbroker-manager'
import type { SupervisorLogEvent, SupervisorRestart } from '@/hostd/supervisor'
import { computeSourceVersion, resolveSrcRoot, UNVERSIONED_SENTINEL } from '@/hostd/version'

export const hostdCommand = defineCommand({
  meta: {
    name: '_hostd',
    description: 'internal: host-side typeclaw daemon (do not invoke directly)',
    hidden: true,
  },
  async run() {
    const cliEntry = process.argv[1] ?? ''
    const srcRoot = resolveSrcRoot(cliEntry)
    const version = srcRoot === null ? UNVERSIONED_SENTINEL : await computeSourceVersion({ srcRoot })

    const portbroker = createPortbrokerManager({
      onLog: (msg) => writeLogLine(msg),
    })

    const hostdRestart = buildHostdRestart(cliEntry, defaultRestartDeps, version)
    const kakaoRenewal = createKakaoRenewalManager({
      onLog: (event) => writeLogLine(formatLog(event)),
      onRenewalOk: async ({ containerName, cwd }) => {
        // Restart the container so the in-memory KakaoTalk LOCO client picks
        // up the renewed tokens from secrets.json. Without this, the cron
        // would write fresh tokens but the running adapter would keep using
        // the old token in its closure and still 401 at the ~7-day wall.
        const result = await hostdRestart({ containerName, cwd })
        if (!result.ok) throw new Error(result.reason)
      },
      shouldRenew: ({ cwd }) => kakaoChannelConfigured(cwd),
    })

    const daemon = await startDaemon({
      onLog: (e) => writeLogLine(formatLog(e)),
      version,
      onShutdown: () => process.exit(0),
      portbroker,
      kakaoRenewal,
      restartPreflight: buildHostdRestartPreflight(cliEntry, version),
      restart: hostdRestart,
    })

    const shutdown = (): void => {
      void daemon
        .stop()
        .then(() => portbroker.drain())
        .then(() => kakaoRenewal.drain())
        .then(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    await new Promise<void>(() => {})
  },
})

export type HostdRestartDeps = {
  validateConfig: (cwd: string) => ValidateConfigResult
  stop: (opts: { cwd: string }) => Promise<StopResult>
  loadConfigSync: (cwd: string) => Config
  start: (opts: StartOptions) => Promise<StartResult>
}

const defaultRestartDeps: HostdRestartDeps = {
  validateConfig,
  stop,
  loadConfigSync,
  start,
}

export function buildHostdRestart(
  cliEntry: string,
  deps: HostdRestartDeps = defaultRestartDeps,
  daemonVersion?: string,
): SupervisorRestart {
  return async ({ containerName, cwd, build = false }) => {
    const drift = await detectSourceDrift(cliEntry, daemonVersion)
    if (drift) return { ok: false, reason: drift }

    const validated = deps.validateConfig(cwd)
    if (!validated.ok) {
      return { ok: false, reason: `invalid config for ${containerName}: ${validated.reason}` }
    }
    const stopResult = await deps.stop({ cwd })
    if (!stopResult.ok) return { ok: false, reason: `stop failed: ${stopResult.reason}` }

    const cfg = deps.loadConfigSync(cwd)
    const startResult = await deps.start({
      cwd,
      preferredHostPort: cfg.port,
      forceBuild: build,
      cliEntry,
      reuseCurrentHostDaemon: true,
    })
    if (!startResult.ok) return { ok: false, reason: `start failed: ${startResult.reason}` }
    return { ok: true }
  }
}

export function buildHostdRestartPreflight(cliEntry: string, daemonVersion: string): RestartPreflight {
  return async () => {
    const drift = await detectSourceDrift(cliEntry, daemonVersion)
    return drift ? { ok: false, reason: drift } : null
  }
}

async function detectSourceDrift(cliEntry: string, daemonVersion: string | undefined): Promise<string | null> {
  if (!daemonVersion || daemonVersion === UNVERSIONED_SENTINEL) return null
  const srcRoot = resolveSrcRoot(cliEntry)
  if (srcRoot === null) return null
  const currentVersion = await computeSourceVersion({ srcRoot })
  if (currentVersion === daemonVersion) return null
  return 'host daemon source has drifted from the current typeclaw source; run `typeclaw restart --build` from the host-stage agent folder so the daemon respawns before rebuilding the Docker image'
}

function writeLogLine(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`)
}

function formatLog(event: DaemonLogEvent | SupervisorLogEvent): string {
  switch (event.kind) {
    case 'daemon-listening':
      return `[hostd] listening on ${event.socket}`
    case 'daemon-http-listening':
      return `[hostd] HTTP control listening on ${event.host}:${event.port}`
    case 'daemon-http-port-fallback':
      return `[hostd] HTTP preferred port ${event.preferred} busy; fell back to ${event.actual} (containers started on ${event.preferred} will see stale TYPECLAW_HOSTD_URL until restarted)`
    case 'daemon-stopping':
      return `[hostd] stopping`
    case 'shutdown-requested':
      return `[hostd] shutdown requested (version drift); exiting so the next CLI call respawns`
    case 'register':
      return `[hostd] registered ${event.containerName}`
    case 'deregister':
      return `[hostd] deregistered ${event.containerName} (${event.reason})`
    case 'registration-skipped':
      return `[hostd] skipped persisted registration ${event.containerName}: ${event.reason}`
    case 'restart-scheduled':
      return `[hostd] restart scheduled for ${event.containerName}${event.build ? ' (with rebuild)' : ''}`
    case 'restart-completed':
      return `[hostd] restart completed for ${event.containerName}`
    case 'restart-failed':
      return `[hostd] restart failed for ${event.containerName}: ${event.reason}`
    case 'port-forward-event':
      return formatPortForwardEvent(event.event)
    case 'tailscale-serve-event':
      return formatTailscaleServeEvent(event.event)
    case 'kakao-renewal-tick-start':
      return `[hostd] kakao renewal tick started for ${event.containerName}`
    case 'kakao-renewal-tick-skipped':
      return `[hostd] kakao renewal skipped for ${event.containerName}: ${event.reason}${event.ageMs !== undefined ? ` (age=${Math.round(event.ageMs / 1000 / 60 / 60)}h)` : ''}`
    case 'kakao-renewal-tick-ok':
      return `[hostd] kakao renewal OK for ${event.containerName} account=${event.accountId} (was last updated ${event.previousUpdatedAt})`
    case 'kakao-renewal-tick-reauth-required':
      return `[hostd] kakao renewal REAUTH REQUIRED for ${event.containerName} account=${event.accountId} reason=${event.reason} — ${event.message}`
    case 'kakao-renewal-tick-transient-failure':
      return `[hostd] kakao renewal transient failure for ${event.containerName} account=${event.accountId}: ${event.reason}`
    case 'kakao-renewal-tick-error':
      return `[hostd] kakao renewal ERROR for ${event.containerName}: ${event.error}`
    case 'kakao-renewal-restart-scheduled':
      return `[hostd] kakao renewal scheduled container restart for ${event.containerName} account=${event.accountId}`
    case 'kakao-renewal-restart-failed':
      return `[hostd] kakao renewal container restart FAILED for ${event.containerName} account=${event.accountId}: ${event.reason}`
  }
}

// Reads the agent's typeclaw.json to decide whether the kakao renewal cron
// should run for this container. Without this, every typeclaw agent on the
// host gets a daily `no_account` skip event from the renewal manager — log
// spam for non-kakao agents. Returns false on read/parse errors so the
// renewal cron stays silent for agents we can't classify; the kakao adapter
// itself would surface the real config issue on its next start.
function kakaoChannelConfigured(cwd: string): boolean {
  try {
    const cfg = loadConfigSync(cwd)
    return cfg.channels?.kakaotalk !== undefined
  } catch {
    return false
  }
}

function formatPortForwardEvent(event: import('@/portbroker').PortForwardEvent): string {
  switch (event.kind) {
    case 'port-forward-opened':
      return `[hostd] port-forward opened ${event.containerName}:${event.port} (${event.bindAddr}) → localhost:${event.port}`
    case 'port-forward-closed':
      return `[hostd] port-forward closed ${event.containerName}:${event.port} (${event.reason})`
    case 'port-forward-failed':
      return `[hostd] port-forward FAILED ${event.containerName}:${event.port} — ${event.reason}`
  }
}

function formatTailscaleServeEvent(event: import('@/hostd/tailscale').TailscaleServeEvent): string {
  switch (event.kind) {
    case 'tailscale-serve-opened':
      return `[hostd] tailscale serve opened ${event.containerName}:${event.port}`
    case 'tailscale-serve-closed':
      return `[hostd] tailscale serve closed ${event.containerName}:${event.port}`
    case 'tailscale-serve-skipped':
      return `[hostd] tailscale serve skipped ${event.containerName}:${event.port} — ${event.reason}`
    case 'tailscale-serve-failed':
      return `[hostd] tailscale serve FAILED ${event.containerName}:${event.port} (${event.command}) — ${event.reason}`
  }
}
