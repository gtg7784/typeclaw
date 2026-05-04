import { defineCommand } from 'citty'

import { loadConfigSync, validateConfig, type Config, type ValidateConfigResult } from '@/config'
import { start, stop, type StartOptions, type StartResult, type StopResult } from '@/container'
import { startDaemon, type DaemonLogEvent } from '@/hostd/daemon'
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

    const daemon = await startDaemon({
      onLog: (e) => writeLogLine(formatLog(e)),
      version,
      onShutdown: () => process.exit(0),
      portbroker,
      restart: buildHostdRestart(cliEntry),
    })

    const shutdown = (): void => {
      void daemon
        .stop()
        .then(() => portbroker.drain())
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

export function buildHostdRestart(cliEntry: string, deps: HostdRestartDeps = defaultRestartDeps): SupervisorRestart {
  return async ({ containerName, cwd }) => {
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
      cliEntry,
      reuseCurrentHostDaemon: true,
    })
    if (!startResult.ok) return { ok: false, reason: `start failed: ${startResult.reason}` }
    return { ok: true }
  }
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
      return `[hostd] restart scheduled for ${event.containerName}`
    case 'restart-completed':
      return `[hostd] restart completed for ${event.containerName}`
    case 'restart-failed':
      return `[hostd] restart failed for ${event.containerName}: ${event.reason}`
    case 'port-forward-event':
      return formatPortForwardEvent(event.event)
    case 'tailscale-serve-event':
      return formatTailscaleServeEvent(event.event)
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
